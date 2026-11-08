import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import { PrismaClient } from "@prisma/client";
import express from "express";
import { scrapeTweetData } from "./lib/api-twitter-scraper";
import { scrapePixivMetadata, extractPixivId } from "./lib/scraper-pixiv";

// Khởi tạo Prisma và Discord Client
const prisma = new PrismaClient();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ============================================================================
// HÀM TIỆN ÍCH (UTILITIES)
// ============================================================================
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/g, "")
    .replace(/\-\-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const resolveOriginalPostId = async (postId: string) => {
  const direct = await prisma.originalPost.findFirst({
    where: { OR: [{ id: postId }, { tweetId: postId }] },
    select: { id: true },
  });
  if (direct) return direct.id;

  const translated = await prisma.translatedPost.findFirst({
    where: { OR: [{ id: postId }, { tweetId: postId }] },
    select: { originalPostId: true },
  });
  return translated?.originalPostId || null;
};

// ============================================================================
// 1. WEB SERVER CHỐNG NGỦ ĐÔNG TRÊN RENDER
// ============================================================================
const app = express();
app.get("/", (req, res) => res.send("Umazing Index Discord Bot is awake!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Keep-alive server running on port ${PORT}`),
);

// ============================================================================
// 2. DISCORD EVENT LISTENERS
// ============================================================================
client.once("ready", () => {
  console.log(`Bot logged in successfully as ${client.user?.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  // -------------------------------------------------------------------------
  // XỬ LÝ LỆNH /scrape
  // -------------------------------------------------------------------------
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "scrape") {
      const transUrl = interaction.options.getString("url", true);
      const explicitOrigUrl =
        interaction.options.getString("original_url") || undefined;
      const language = interaction.options.getString("lang") || "en";
      const callerUser =
        interaction.user.globalName || interaction.user.username;

      // Trả lời "Đang xử lý" để không bị timeout
      await interaction.deferReply();

      try {
        // MỘT SỐ HÀM DƯỚI ĐÂY YÊU CẦU BẠN PHẢI COPY `scrapeSinglePost` TỪ NEXT.JS QUA
        // Nếu không cần chức năng /scrape trong Bot, bạn có thể xóa luôn khối if này.
        const { scrapeSinglePost } = await import("./lib/scrape-single-api");

        const scrapeResult = await scrapeSinglePost({
          inputUrl: transUrl,
          explicitOriginalUrl: explicitOrigUrl,
          targetLanguage: language,
        });

        const baseUrl =
          process.env.NEXT_PUBLIC_SITE_URL || "https://www.uma-index.top";
        const comicLink = `${baseUrl}/post/${scrapeResult.originalPostId}?tl=${scrapeResult.transTweetId}`;

        let sourceSummary = `⚠️ *Original post not found*`;
        if (scrapeResult.sourceType === "PIXIV") {
          sourceSummary = `🎨 [Pixiv #${extractPixivId(scrapeResult.sourceUrl)}](${scrapeResult.sourceUrl})`;
        } else if (scrapeResult.sourceType === "TWITTER") {
          sourceSummary = `🐦 [Twitter Status](${scrapeResult.sourceUrl})`;
        }

        const successEmbed = new EmbedBuilder()
          .setTitle(`✅ Comic Scraped Successfully!`)
          .setColor(0x3db4f2)
          .addFields(
            {
              name: "Artist",
              value: `**${scrapeResult.artistName}** (\`${scrapeResult.artistHandle}\`)`,
              inline: true,
            },
            {
              name: "Translator",
              value: `**${scrapeResult.translatorName}** (\`${scrapeResult.translatorHandle}\`)`,
              inline: true,
            },
            { name: "Original Source", value: sourceSummary, inline: false },
            {
              name: "Media",
              value: `**${scrapeResult.translatedImagesCount}** translated page(s)`,
              inline: true,
            },
            { name: "Invoked By", value: `\`${callerUser}\``, inline: true },
            {
              name: "View Post",
              value: `[🔗 Open comic on website](${comicLink})`,
              inline: false,
            },
          )
          .setFooter({ text: "Umazing Index • Manual Scraper" })
          .setTimestamp();

        await interaction.editReply({ embeds: [successEmbed] });
      } catch (err: any) {
        console.error("Manual scrape error:", err);
        const errorEmbed = new EmbedBuilder()
          .setTitle(`❌ Failed to Scrape Comic`)
          .setColor(0xef4444)
          .setDescription(`\`\`\`${err.message || String(err)}\`\`\``)
          .addFields(
            { name: "Target URL", value: transUrl },
            { name: "Invoked By", value: `\`${callerUser}\`` },
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [errorEmbed] });
      }
    }
    return;
  }

  // -------------------------------------------------------------------------
  // XỬ LÝ NÚT BẤM (Approve / Reject)
  // -------------------------------------------------------------------------
  if (interaction.isButton()) {
    const [action, reportId] = interaction.customId.split(":");
    if (!reportId) return;

    const modUsername =
      interaction.user.globalName || interaction.user.username;

    // Phản hồi Discord trước để tránh lỗi Timeout (Stream closed)
    await interaction.deferUpdate();

    try {
      const report = await prisma.comicReport.findUnique({
        where: { id: reportId },
      });

      if (!report) {
        await interaction.editReply({
          content: "⚠️ This report no longer exists in the database.",
          embeds: [],
          components: [],
        });
        return;
      }

      // =======================================================================
      // DUYỆT REPORT (APPROVE)
      // =======================================================================
      if (action === "approve") {
        const lock = await prisma.comicReport.updateMany({
          where: { id: reportId, status: "PENDING" },
          data: { status: "APPROVED", handledBy: modUsername },
        });

        if (lock.count === 0) {
          await interaction.followUp({
            content:
              "⚠️ This report is already being processed or has been completed.",
            ephemeral: true,
          });
          return;
        }

        const targetOriginalPostId = await resolveOriginalPostId(report.postId);

        if (!targetOriginalPostId) {
          await prisma.comicReport.update({
            where: { id: reportId },
            data: { status: "PENDING", handledBy: null },
          });

          await interaction.followUp({
            content: `⚠️ Could not find any original post associated with ID: \`${report.postId}\``,
            ephemeral: true,
          });
          return;
        }

        let appliedDetails = report.content;

        // --- 1. HANDLE ORIGINAL_LINK ---
        if (report.type === "ORIGINAL_LINK") {
          const pixivId = extractPixivId(report.content);
          const tweetIdMatch = report.content.match(/status\/(\d+)/);

          if (pixivId) {
            const pixivData = await scrapePixivMetadata(report.content);
            if (!pixivData || pixivData.mediaUrls.length === 0) {
              throw new Error(
                "Pixiv illustration metadata not found or has no images.",
              );
            }

            const artistHandle = `@${pixivData.artistAccount}`;
            const creator = await prisma.creator.upsert({
              where: { handle: artistHandle },
              update: {
                name: pixivData.artistName,
                profileUrl: pixivData.profileUrl,
              },
              create: {
                handle: artistHandle,
                name: pixivData.artistName,
                profileUrl: pixivData.profileUrl,
                role: "ARTIST",
              },
            });

            const pixivUniqueId = `pixiv-${pixivId}`;
            const existingOriginalPost = await prisma.originalPost.findUnique({
              where: { tweetId: pixivUniqueId },
            });

            if (existingOriginalPost) {
              await prisma.translatedPost.updateMany({
                where: {
                  OR: [
                    { id: report.postId },
                    { originalPostId: targetOriginalPostId },
                  ],
                },
                data: { originalPostId: existingOriginalPost.id },
              });

              await prisma.originalPost.update({
                where: { id: existingOriginalPost.id },
                data: {
                  mediaUrls: pixivData.mediaUrls,
                  mediaCount: pixivData.mediaUrls.length,
                  content: pixivData.title || undefined,
                  postedAt: new Date(pixivData.postedAt),
                  artistId: creator.id,
                },
              });

              if (targetOriginalPostId !== existingOriginalPost.id) {
                const remaining = await prisma.translatedPost.count({
                  where: { originalPostId: targetOriginalPostId },
                });
                if (remaining === 0) {
                  await prisma.postTag.deleteMany({
                    where: { postId: targetOriginalPostId },
                  });
                  await prisma.originalPost
                    .delete({ where: { id: targetOriginalPostId } })
                    .catch(() => {});
                }
              }
            } else {
              await prisma.originalPost.update({
                where: { id: targetOriginalPostId },
                data: {
                  tweetId: pixivUniqueId,
                  tweetUrl: `https://www.pixiv.net/artworks/${pixivId}`,
                  content: pixivData.title || "",
                  mediaUrls: pixivData.mediaUrls,
                  mediaCount: pixivData.mediaUrls.length,
                  postedAt: new Date(pixivData.postedAt),
                  artist: { connect: { id: creator.id } },
                },
              });
            }

            appliedDetails = [
              `🎨 **Pixiv Source Linked:** [Pixiv #${pixivId}](https://www.pixiv.net/artworks/${pixivId})`,
              `Artist: **${pixivData.artistName}** (\`${artistHandle}\`)`,
              `Images: **${pixivData.mediaUrls.length}** page(s)`,
            ].join(" • ");
          } else if (tweetIdMatch) {
            const tweetId = tweetIdMatch[1];
            const tweetUrl = `https://x.com/i/status/${tweetId}`;
            const scraped = await scrapeTweetData(tweetUrl);

            let artistId: string | undefined;
            let artistInfo = "";

            if (scraped?.artistHandle) {
              const artistHandle = scraped.artistHandle;
              const artistName = scraped.artistName || artistHandle;
              const profileUrl = `https://x.com/${artistHandle}`;

              const creator = await prisma.creator.upsert({
                where: { handle: artistHandle },
                update: { name: artistName, profileUrl },
                create: {
                  handle: artistHandle,
                  name: artistName,
                  profileUrl,
                  role: "ARTIST",
                },
              });
              artistId = creator.id;
              artistInfo = `Artist: **${artistName}** (\`@${artistHandle}\`)`;
            }

            const existingOriginalPost = await prisma.originalPost.findUnique({
              where: { tweetId },
            });
            let finalOriginalPostId = targetOriginalPostId;

            if (existingOriginalPost) {
              finalOriginalPostId = existingOriginalPost.id;
              await prisma.translatedPost.updateMany({
                where: {
                  OR: [
                    { id: report.postId },
                    { originalPostId: targetOriginalPostId },
                  ],
                },
                data: { originalPostId: existingOriginalPost.id },
              });

              if (scraped && scraped.mediaUrls.length > 0) {
                await prisma.originalPost.update({
                  where: { id: existingOriginalPost.id },
                  data: {
                    mediaUrls: scraped.mediaUrls,
                    mediaCount: scraped.mediaUrls.length,
                    ...(scraped.text ? { content: scraped.text } : {}),
                    ...(scraped.postedAt ? { postedAt: scraped.postedAt } : {}),
                    ...(artistId ? { artistId } : {}),
                  },
                });
              }

              if (targetOriginalPostId !== existingOriginalPost.id) {
                const remaining = await prisma.translatedPost.count({
                  where: { originalPostId: targetOriginalPostId },
                });
                if (remaining === 0) {
                  await prisma.postTag.deleteMany({
                    where: { postId: targetOriginalPostId },
                  });
                  await prisma.originalPost
                    .delete({ where: { id: targetOriginalPostId } })
                    .catch(() => {});
                }
              }
            } else {
              const updateData: any = {
                tweetId,
                tweetUrl,
                ...(artistId ? { artist: { connect: { id: artistId } } } : {}),
              };

              if (scraped && scraped.mediaUrls.length > 0) {
                updateData.mediaUrls = scraped.mediaUrls;
                updateData.mediaCount = scraped.mediaUrls.length;
                if (scraped.text) updateData.content = scraped.text;
                if (scraped.postedAt) updateData.postedAt = scraped.postedAt;
              }

              await prisma.originalPost.update({
                where: { id: targetOriginalPostId },
                data: updateData,
              });
            }

            const imgCount = scraped?.mediaUrls.length || 0;
            appliedDetails = [
              existingOriginalPost
                ? `🔗 Linked to Existing Original Post (\`${finalOriginalPostId}\`)`
                : `Updated Tweet URL: ${tweetUrl}`,
              artistInfo,
              imgCount > 0 ? `Fetched **${imgCount}** raw image(s)` : "",
            ]
              .filter(Boolean)
              .join(" • ");
          } else {
            throw new Error(
              "Invalid link: Must be a Twitter/X or Pixiv artwork URL.",
            );
          }
        }

        // --- 2. HANDLE CHARACTER_TAG ---
        else if (report.type === "CHARACTER_TAG") {
          let tagData: {
            action: string;
            tags?: string[];
            tag?: string;
            oldTag?: string;
            newTag?: string;
          } = { action: "ADD" };

          try {
            tagData = JSON.parse(report.content);
          } catch {
            tagData = { action: "ADD", tag: report.content.trim() };
          }

          const targetTags: string[] = Array.isArray(tagData.tags)
            ? tagData.tags.map((t) => t.trim()).filter(Boolean)
            : tagData.tag
              ? tagData.tag
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean)
              : [];

          // 🌟 XỬ LÝ HÀNH ĐỘNG "UPDATE" TỪ UI MỚI
          if (tagData.action === "UPDATE") {
            const tagsToAdd: string[] = [];
            const tagsToRemove: string[] = [];

            for (const t of targetTags) {
              if (t.startsWith("REMOVE::")) {
                tagsToRemove.push(t.replace("REMOVE::", "").trim());
              } else {
                tagsToAdd.push(t.trim());
              }
            }

            if (tagsToRemove.length > 0) {
              const tagsToDelete = await prisma.tag.findMany({
                where: { name: { in: tagsToRemove } },
              });
              const tagIds = tagsToDelete.map((t) => t.id);
              if (tagIds.length > 0) {
                await prisma.postTag.deleteMany({
                  where: {
                    postId: targetOriginalPostId,
                    tagId: { in: tagIds },
                  },
                });
              }
            }

            if (tagsToAdd.length > 0) {
              for (const tagName of tagsToAdd) {
                const slug = slugify(tagName) || `tag-${Date.now()}`;
                const tag = await prisma.tag.upsert({
                  where: { name: tagName },
                  update: {},
                  create: { name: tagName, slug, category: "CHARACTER" },
                });

                await prisma.postTag.upsert({
                  where: {
                    postId_tagId: {
                      postId: targetOriginalPostId,
                      tagId: tag.id,
                    },
                  },
                  update: { isManual: true },
                  create: {
                    postId: targetOriginalPostId,
                    tagId: tag.id,
                    isManual: true,
                  },
                });
              }
            }

            const details = [];
            if (tagsToAdd.length > 0)
              details.push(
                `➕ **Add:** ${tagsToAdd.map((t) => `\`${t}\``).join(", ")}`,
              );
            if (tagsToRemove.length > 0)
              details.push(
                `❌ **Remove:** ${tagsToRemove.map((t) => `\`${t}\``).join(", ")}`,
              );
            appliedDetails =
              details.length > 0 ? details.join("\n") : "*(No changes)*";
          }
          // (Dự phòng cho UI cũ)
          else if (tagData.action === "ADD" && targetTags.length > 0) {
            for (const tagName of targetTags) {
              const slug = slugify(tagName) || `tag-${Date.now()}`;
              const tag = await prisma.tag.upsert({
                where: { name: tagName },
                update: {},
                create: { name: tagName, slug, category: "CHARACTER" },
              });
              await prisma.postTag.upsert({
                where: {
                  postId_tagId: { postId: targetOriginalPostId, tagId: tag.id },
                },
                update: { isManual: true },
                create: {
                  postId: targetOriginalPostId,
                  tagId: tag.id,
                  isManual: true,
                },
              });
            }
            appliedDetails = `➕ Added Tag(s): ${targetTags.map((t) => `**${t}**`).join(", ")}`;
          } else if (tagData.action === "REMOVE" && targetTags.length > 0) {
            for (const tagName of targetTags) {
              const tag = await prisma.tag.findUnique({
                where: { name: tagName },
              });
              if (tag) {
                await prisma.postTag.deleteMany({
                  where: { postId: targetOriginalPostId, tagId: tag.id },
                });
              }
            }
            appliedDetails = `❌ Removed Tag(s): ${targetTags.map((t) => `**${t}**`).join(", ")}`;
          } else if (
            tagData.action === "REPLACE" &&
            tagData.oldTag &&
            tagData.newTag
          ) {
            const oldTag = await prisma.tag.findUnique({
              where: { name: tagData.oldTag },
            });
            if (oldTag) {
              await prisma.postTag.deleteMany({
                where: { postId: targetOriginalPostId, tagId: oldTag.id },
              });
            }
            const newSlug = slugify(tagData.newTag) || `tag-${Date.now()}`;
            const newTag = await prisma.tag.upsert({
              where: { name: tagData.newTag },
              update: {},
              create: {
                name: tagData.newTag,
                slug: newSlug,
                category: "CHARACTER",
              },
            });
            await prisma.postTag.upsert({
              where: {
                postId_tagId: {
                  postId: targetOriginalPostId,
                  tagId: newTag.id,
                },
              },
              update: { isManual: true },
              create: {
                postId: targetOriginalPostId,
                tagId: newTag.id,
                isManual: true,
              },
            });
            appliedDetails = `🔄 Replaced: **${tagData.oldTag}** ➔ **${tagData.newTag}**`;
          }
        }

        // --- 3. HANDLE BROKEN_MEDIA ---
        else if (report.type === "BROKEN_MEDIA") {
          let mediaData: {
            target?: "ORIGINAL" | "TRANSLATED";
            tweetUrl?: string;
            note?: string;
          } = {};
          try {
            mediaData = JSON.parse(report.content);
          } catch {
            mediaData = {
              target: "TRANSLATED",
              tweetUrl: report.content.trim(),
            };
          }

          if (!mediaData.tweetUrl)
            throw new Error("Missing source URL to scrape images.");

          let mediaUrls: string[] = [];
          let textContent: string | undefined;
          const pixivId = extractPixivId(mediaData.tweetUrl);

          if (pixivId) {
            const pixivScraped = await scrapePixivMetadata(mediaData.tweetUrl);
            if (!pixivScraped || pixivScraped.mediaUrls.length === 0)
              throw new Error("No images found in the provided Pixiv artwork.");
            mediaUrls = pixivScraped.mediaUrls;
            textContent = pixivScraped.title;
          } else {
            const scraped = await scrapeTweetData(mediaData.tweetUrl);
            if (!scraped || scraped.mediaUrls.length === 0)
              throw new Error("No images found in the provided Twitter post.");
            mediaUrls = scraped.mediaUrls;
            textContent = scraped.text;
          }

          if (mediaData.target === "ORIGINAL") {
            await prisma.originalPost.update({
              where: { id: targetOriginalPostId },
              data: {
                mediaUrls,
                mediaCount: mediaUrls.length,
                ...(textContent ? { content: textContent } : {}),
              },
            });
            appliedDetails = `🖼️ **Restored Raw Images:** Replaced with **${mediaUrls.length}** image(s) from [Source](${mediaData.tweetUrl})`;
          } else {
            const translatedPost = await prisma.translatedPost.findFirst({
              where: {
                OR: [
                  { id: report.postId },
                  { originalPostId: targetOriginalPostId },
                ],
              },
            });
            if (!translatedPost)
              throw new Error("Translated comic record not found.");

            await prisma.translatedPost.update({
              where: { id: translatedPost.id },
              data: { mediaUrls },
            });
            appliedDetails = `🌐 **Restored Translated Images:** Replaced with **${mediaUrls.length}** image(s) from [Source](${mediaData.tweetUrl})`;
          }
        }

        // --- 4. HANDLE IRRELEVANT_CONTENT ---
        else if (report.type === "IRRELEVANT_CONTENT") {
          await prisma.postTag.deleteMany({
            where: { postId: targetOriginalPostId },
          });
          await prisma.translatedPost.deleteMany({
            where: { originalPostId: targetOriginalPostId },
          });
          await prisma.originalPost
            .delete({ where: { id: targetOriginalPostId } })
            .catch(() => {});
          appliedDetails = `🗑️ **Content Deleted:** The post and all its translations/tags have been permanently removed.`;
        }

        // TẠO GIAO DIỆN EMBED ĐẸP NHƯ CŨ (XANH LÁ)
        const successEmbed = new EmbedBuilder()
          .setTitle(`✅ Report #${report.id} APPROVED`)
          .setColor(0x22c55e)
          .addFields(
            {
              name: "Original Post ID",
              value: `\`${targetOriginalPostId}\``,
              inline: true,
            },
            { name: "Type", value: `\`${report.type}\``, inline: true },
            { name: "Approved By", value: `**${modUsername}**`, inline: true },
            { name: "Applied Action", value: appliedDetails },
          )
          .setFooter({ text: "Umazing Index • Status Updated" })
          .setTimestamp();

        await interaction.editReply({
          content: null,
          embeds: [successEmbed],
          components: [],
        });
      }

      // =======================================================================
      // TỪ CHỐI REPORT (REJECT)
      // =======================================================================
      else if (action === "reject") {
        const lock = await prisma.comicReport.updateMany({
          where: { id: reportId, status: "PENDING" },
          data: { status: "REJECTED", handledBy: modUsername },
        });

        if (lock.count === 0) {
          await interaction.followUp({
            content: "⚠️ This report has already been processed.",
            ephemeral: true,
          });
          return;
        }

        const rejectEmbed = new EmbedBuilder()
          .setTitle(`❌ Report #${report.id} REJECTED`)
          .setColor(0xef4444)
          .addFields(
            { name: "Report ID", value: `\`${report.id}\``, inline: true },
            { name: "Type", value: `\`${report.type}\``, inline: true },
            { name: "Rejected By", value: `**${modUsername}**`, inline: true },
            { name: "Submitted Content", value: report.content || "*(Empty)*" },
          )
          .setFooter({ text: "Umazing Index • Dismissed" })
          .setTimestamp();

        await interaction.editReply({
          content: null,
          embeds: [rejectEmbed],
          components: [],
        });
      }
    } catch (err: any) {
      console.error("Action error:", err);

      await prisma.comicReport
        .update({
          where: { id: reportId },
          data: { status: "PENDING", handledBy: null },
        })
        .catch(() => {});

      const errorEmbed = new EmbedBuilder()
        .setTitle(`⚠️ Action Failed: Report #${reportId}`)
        .setColor(0xf59e0b)
        .addFields(
          {
            name: "📌 Reason",
            value: "Database execution failed or external API error.",
            inline: false,
          },
          {
            name: "💡 Suggestion",
            value: err.message || String(err),
            inline: false,
          },
          { name: "Attempted By", value: `**${modUsername}**`, inline: true },
        )
        .setFooter({
          text: "Umazing Index • Action aborted, report restored to PENDING",
        })
        .setTimestamp();

      await interaction.editReply({
        content: null,
        embeds: [errorEmbed],
        components: [],
      });
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
