const express = require("express");
const app = express();
app.use(express.json());
app.use(require("cors")());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SUPPORT_USERNAME = "FissionHelp";
const VENDOR_FEE_STARS = 57;
const CHANNEL_USERNAME = "CalibazHQ";
const ADMIN_IDS = [1256464530, 7310115244];

const crypto = require("crypto");
const TEST_CATEGORY = "Test Items (Admin Only)";
function isAdminInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calc = crypto.createHmac("sha256", secret).update(check).digest("hex");
    if (calc !== hash) return false;
    return ADMIN_IDS.includes(JSON.parse(params.get("user")).id);
  } catch (e) {
    return false;
  }
}

const CATEGORIES = [
  "Custom/Handmade Requests",
  "Digital Services",
  "Herbarium & Herbal Products",
  "Electronics & Gadgets",
  "Fruit Juice & Related Products",
  "Cake & Related Products",
  "Land & Housing",
  "Fashion & Apparel",
  "Home & Lifestyle",
  "Beauty & Personal Care",
  "Food & Related Products"
];
const LAND_HOUSING_INDEX = CATEGORIES.indexOf("Land & Housing");

const { MongoClient } = require("mongodb");
const MONGO_URI = process.env.MONGO_URI;
const client = new MongoClient(MONGO_URI);
let adEventsCollection, reportsCollection, ratingsCollection, productsCollection, verifiedCollection, adsCollection, usersCollection, dealsCollection, relayCollection, logCollection, alertsCollection;

async function connectDB() {
  await client.connect();
  const db = client.db("calibaz");
  productsCollection = db.collection("products");
  verifiedCollection = db.collection("verified_vendors");
  adsCollection = db.collection("ads");
  shareCollection = db.collection("share_events");
  codesCollection = db.collection("vendor_codes");
  usersCollection = db.collection("users");
  dealsCollection = db.collection("deals");
  relayCollection = db.collection("relay_map");
  logCollection = db.collection("deal_messages");
  alertsCollection = db.collection("vendor_alerts");
  ratingsCollection = db.collection("ratings");
  reportsCollection = db.collection("reports");
  adEventsCollection = db.collection("ad_events");
  console.log("Connected to MongoDB");
}
connectDB().catch(err => console.error("MongoDB connection error:", err));

async function loadProducts() {
  return await productsCollection.find({}).toArray();
}

async function saveProduct(product) {
  await productsCollection.insertOne(product);
}

app.get("/", (req, res) => {
  res.send("CaliBaz Market backend is running.");
});

app.get("/products", async (req, res) => {
  try {
    const products = await loadProducts();
    const isAdmin = isAdminInitData(req.headers["x-init-data"] || ""); const vv = (await verifiedCollection.find({}).toArray()).map(v => v.vendor); const rtAgg = await ratingsCollection.aggregate([{ $group: { _id: "$vendor", avg: { $avg: "$stars" }, n: { $sum: 1 } } }]).toArray(); const rtMap = {}; rtAgg.forEach(r => { rtMap[r._id] = r; }); res.json(products.filter(p => isAdmin || p.category !== TEST_CATEGORY).map(p => ({ ...p, verified: vv.includes((p.vendor || "").toLowerCase()), ratingAvg: (rtMap[(p.vendor || "").replace("@", "").toLowerCase()] || {}).avg || null, ratingCount: (rtMap[(p.vendor || "").replace("@", "").toLowerCase()] || {}).n || 0 })));
  } catch (err) {
    res.status(500).json({ error: "Could not load products" });
  }
});

app.post("/webhook", async (req, res) => {
  const update = req.body;

  if (update.message) {
    const chatId = update.message.chat.id;
    const text = update.message.text || update.message.caption || "";
    try {
      const fromUser = update.message.from;
      if (update.message.chat.type === "private" && fromUser && !fromUser.is_bot) {
        await usersCollection.updateOne(
          { chatId },
          { $set: { chatId, username: (fromUser.username || "").toLowerCase(), name: fromUser.first_name || "" } },
          { upsert: true }
        );
      }
      const isAdminUser = !!fromUser && ADMIN_IDS.includes(fromUser.id);

      if (text === "/start vendor") {
        await sendMessage(chatId, "You're set up as a CaliBaz vendor ✅\n\nWhen a buyer taps I'm Interested on your product, their messages arrive here. Tap ↩️ Reply under a message to answer them.");
      }

      if (text.startsWith("/start shop_")) {
        let shopUser = text.replace("/start shop_", "").trim().replace(/^@/, "");
        try {
          if (codesCollection && /^[a-z0-9]{6}$/.test(shopUser)) {
            const cd = await codesCollection.findOne({ code: shopUser });
            if (cd) shopUser = cd.user;
          }
        } catch (e) {}
        if (!/^[A-Za-z0-9_]{3,40}$/.test(shopUser)) {
          await sendMessage(chatId, "That shop link doesn't look right.");
        } else {
          await sendMessage(chatId, "🛍️ Tap below to open this shop on CaliBaz Market.", {
            inline_keyboard: [[{ text: "🛍️ Open shop", web_app: { url: "https://1fission.github.io/calibaz-market/?shop=" + shopUser } }]]
          });
        }
      } else if (text.startsWith("/start deal_")) {
        const productId = text.replace("/start deal_", "").trim();
        const memberOk = await isChannelMember(fromUser.id);
        if (!memberOk) {
          await sendMessage(chatId, "To chat with vendors on CaliBaz, please join our channel first 👇", {
            inline_keyboard: [
              [{ text: "📢 Join CaliBaz Channel", url: `https://t.me/${CHANNEL_USERNAME}` }],
              [{ text: "✅ I've Joined - Continue", url: `https://t.me/CaliBazbot?start=deal_${productId}` }]
            ]
          });
        }
        const product = memberOk ? await productsCollection.findOne({ id: productId }) : null;
        if (!product) {
          if (memberOk) await sendMessage(chatId, "Sorry, that listing is no longer available.");
        } else {
          const vendorHandle = (product.vendor || "").replace("@", "");
          const vendorLabel = product.vendorName || vendorHandle;
          const vendorUser = vendorHandle ? await usersCollection.findOne({ username: vendorHandle.toLowerCase() }) : null;
          const existing = await dealsCollection.findOne({ productId, buyerChatId: chatId, status: "open" });
          if (existing) {
            await usersCollection.updateOne({ chatId }, { $set: { activeDealId: existing.dealId } });
            await sendDealMsg(chatId, `You already have an open chat for this product. Just type your message here.`, existing.dealId);
          } else if (!vendorUser) {
            await sendDirectLink(chatId, vendorHandle, vendorLabel, product);
          } else if (vendorUser.chatId === chatId) {
            await sendMessage(chatId, "That's your own listing.");
          } else {
            const dealId = Date.now().toString(36);
            const buyerName = fromUser.first_name || "Buyer";
            await dealsCollection.insertOne({
              dealId, productId, productName: product.name,
              buyerChatId: chatId, buyerName,
              vendorChatId: vendorUser.chatId, vendorName: vendorLabel,
              status: "open", paid: false, createdAt: Date.now(), lastActivity: Date.now()
            });
            await logDeal(dealId, "system", "System", `Deal opened: ${buyerName} and ${vendorLabel} about "${product.name}"`);
            await usersCollection.updateOne({ chatId }, { $set: { activeDealId: dealId } });
            const reached = await sendDealMsg(vendorUser.chatId, `🛍️ New buyer for "${product.name}".\n\nTap ↩️ Reply below to answer them. Messages are recorded for escrow and dispute resolution. When you've been paid, tap the button below.`, dealId, {
              inline_keyboard: [[{ text: "✅ Payment received", callback_data: `dp_${dealId}` }], [{ text: "↩️ Reply", callback_data: `rp_${dealId}` }]]
            });
            if (!reached) {
              await dealsCollection.updateOne({ dealId }, { $set: { status: "closed", closedAt: Date.now(), closedReason: "vendor unreachable" } });
              await sendDirectLink(chatId, vendorHandle, vendorLabel, product);
            } else {
              await sendDealMsg(chatId, `✅ Connected to ${vendorLabel} about "${product.name}".\n\nType your message here and I'll pass it on. Messages here are recorded for escrow and dispute resolution. Want escrow? Ask @${SUPPORT_USERNAME}. Send /enddeal to cancel.\n\nProblem with the vendor? Tap 🚩 below or send /report.`, dealId, { inline_keyboard: [[{ text: "🚩 Report a problem", callback_data: `rpt_${dealId}` }]] });
            }
          }
        }
      }

      if (text === "/vendors") {
        if (!isAdminUser) {
          await sendMessage(chatId, "You're not authorized to use this command.");
        } else {
          const prods = await productsCollection.find({}).toArray();
          const seen = new Map();
          for (const p of prods) {
            const h = (p.vendor || "").replace("@", "").toLowerCase();
            const key = h || ("name:" + (p.vendorName || ""));
            if (!seen.has(key)) seen.set(key, { handle: h, label: p.vendorName || h || "Unknown" });
          }
          const handles = [...seen.values()].map(v => v.handle).filter(Boolean);
          const started = await usersCollection.find({ username: { $in: handles } }).toArray();
          const startedSet = new Set(started.map(u => u.username));
          const rows = [...seen.values()].map(v => {
            const ok = v.handle && startedSet.has(v.handle);
            return `${ok ? "✅ Connected" : "⚠️ Not started"} | ${v.label}${v.handle ? " (@" + v.handle + ")" : " (no username)"}`;
          });
          rows.sort();
          await sendMessage(chatId, rows.length ? `Vendors: ${rows.length}\n\n` + rows.join("\n") : "No vendors yet.");
        }
      }

      if (text === "/mystats") {
        const msUser = ((update.message.from && update.message.from.username) || "").toLowerCase();
        if (!msUser) {
          await sendMessage(chatId, "Set a Telegram username first (Settings > Username), then send /mystats again.");
        } else {
          const msProds = await productsCollection.find({ vendor: new RegExp("^@?" + msUser + "$", "i") }).toArray();
          if (!msProds.length) {
            await sendMessage(chatId, "No listings found for @" + msUser + " yet. Tap Become a Vendor to start selling.");
          } else {
            const msIds = msProds.map(p => p.id);
            const msDeals = await dealsCollection.find({ productId: { $in: msIds } }).toArray();
            const msRts = await ratingsCollection.find({ vendor: msUser }).toArray();
            const msAvg = msRts.length ? (msRts.reduce((a, r) => a + r.stars, 0) / msRts.length).toFixed(1) : null;
            let msShares = 0;
            try { if (shareCollection) msShares = await shareCollection.countDocuments({ productId: { $in: msIds.map(String) } }); } catch (e) {}
            const msCount = st => msDeals.filter(d => d.status === st).length;
            const msBuyers = new Set(msDeals.map(d => d.buyerChatId)).size;
            const msOut = ["📊 Your CaliBaz stats", ""];
            msOut.push("Listings: " + msProds.length);
            msOut.push("Deals: " + msDeals.length + " (open " + msCount("open") + " · completed " + msCount("completed") + " · closed " + msCount("closed") + ")");
            msOut.push("Payments confirmed: " + msDeals.filter(d => d.paid).length);
            msOut.push("Buyers who chatted: " + msBuyers);
            msOut.push("Rating: " + (msAvg ? "⭐ " + msAvg + " (" + msRts.length + (msRts.length === 1 ? " rating)" : " ratings)") : "none yet"));
            msOut.push("Times your listings were shared: " + msShares);
            await sendMessage(chatId, msOut.join("\n"));
          }
        }
      }

      if (text === "/stats" || text.startsWith("/stats ")) {
        if (!isAdminUser) {
          await sendMessage(chatId, "You're not authorized to use this command.");
        } else {
          const q = text.replace("/stats", "").trim().toLowerCase().replace("@", "");
          const prods = await productsCollection.find({}).toArray();
          const match = q ? prods.filter(p => [p.vendor, p.vendorName].join(" ").toLowerCase().includes(q)) : prods;
          if (q && match.length === 0) {
            await sendMessage(chatId, "No vendor found matching that. Try /vendors to see the list.");
          } else {
            const keyOf = p => (p.vendor || "").replace("@", "").toLowerCase();
            const vKeys = new Set(match.map(p => keyOf(p) || ("name:" + (p.vendorName || ""))));
            const handles = [...vKeys].filter(k => !k.startsWith("name:"));
            const deals = await dealsCollection.find(q ? { productId: { $in: match.map(p => p.id) } } : {}).toArray();
            const rts = await ratingsCollection.find(q ? { vendor: { $in: handles } } : {}).toArray();
            const avg = rts.length ? (rts.reduce((a, r) => a + r.stars, 0) / rts.length).toFixed(1) : null;
            const n = st => deals.filter(d => d.status === st).length;
            const buyers = new Set(deals.map(d => d.buyerChatId)).size;
            const title = q ? ("📊 Stats: " + (vKeys.size === 1 ? (match[0].vendorName || q) : q)) : "📊 CaliBaz stats";
            const out = [title, ""];
            if (!q || vKeys.size > 1) out.push("Vendors: " + vKeys.size);
            out.push("Products: " + match.length);
            out.push("Deals: " + deals.length + " (open " + n("open") + " · completed " + n("completed") + " · closed " + n("closed") + ")");
            out.push("Payments confirmed: " + deals.filter(d => d.paid).length);
            out.push("Buyers who chatted: " + buyers);
            out.push("Rating: " + (avg ? "⭐ " + avg + " (" + rts.length + (rts.length === 1 ? " rating)" : " ratings)") : "no ratings yet"));
            if (!q) {
              try {
              if (shareCollection) {
                const shs = await shareCollection.find({}).toArray();
                out.push("");
                out.push("Shares: " + shs.length);
                const by = {};
                shs.forEach(x => { by[x.productId] = (by[x.productId] || 0) + 1; });
                const top = Object.entries(by).sort((m, n) => n[1] - m[1]).slice(0, 3);
                if (top.length) {
                  const names = {};
                  try { (await loadProducts()).forEach(p => { names[String(p.id)] = p.name; }); } catch (e) {}
                  out.push("Most shared: " + top.map(t => (names[t[0]] || t[0]) + " (" + t[1] + ")").join(", "));
                }
              }
            } catch (e) {}
            const adDoc = await adsCollection.findOne({ _id: "current" });
              if (adDoc && adDoc.text) {
                const evs = await adEventsCollection.find({ adId: adDoc.setAt || 0 }).toArray();
                const v = evs.filter(e => e.type === "view");
                const c = evs.filter(e => e.type === "click");
                const vt = v.reduce((a, e) => a + e.count, 0);
                const ct = c.reduce((a, e) => a + e.count, 0);
                out.push("");
                out.push("Ad: " + adDoc.text.slice(0, 30));
                out.push("Views: " + vt);
                out.push("Taps: " + ct + " (" + c.length + " unique)");
                if (vt) out.push("Tap rate: " + (ct / vt * 100).toFixed(1) + "%");
              }
            }
            await sendMessage(chatId, out.join("\n"));
          }
        }
      }

      if (text.startsWith("/whoshop")) {
        if (isAdminUser) {
          const wsArg = (text.split(" ").filter(Boolean)[1] || "").replace(/^.*shop_/, "").replace(/^@/, "").toLowerCase();
          let wsDoc = null;
          try {
            if (wsArg && codesCollection) wsDoc = (await codesCollection.findOne({ code: wsArg })) || (await codesCollection.findOne({ user: wsArg }));
          } catch (e) {}
          if (!wsDoc) {
            await sendMessage(chatId, "No shop found. Use /whoshop followed by the code or link.");
          } else {
            const wsProds = await productsCollection.find({ vendor: new RegExp("^" + wsDoc.user + "$", "i") }).toArray();
            const wsNames = Array.from(new Set(wsProds.map(p => p.vendorName).filter(Boolean)));
            await sendMessage(chatId, "🔎 Shop " + wsDoc.code + "\nOwner: @" + wsDoc.user + "\nDisplay names: " + (wsNames.join(", ") || "none") + "\nListings: " + wsProds.length + "\nLink: https://t.me/CaliBazbot?start=shop_" + wsDoc.code);
          }
        }
      }

      if (text.startsWith("/moveshop")) {
        if (isAdminUser) {
          const msParts = text.split(" ").filter(Boolean);
          const msOld = (msParts[1] || "").replace(/^@/, "");
          const msNew = (msParts[2] || "").replace(/^@/, "");
          if (!/^[A-Za-z0-9_]{3,40}$/.test(msOld) || !/^[A-Za-z0-9_]{3,40}$/.test(msNew)) {
            await sendMessage(chatId, "Use: /moveshop oldusername newusername");
          } else {
            try {
              let linkMsg = "No shop link existed for the old username.";
              const oldDoc = codesCollection ? await codesCollection.findOne({ user: msOld.toLowerCase() }) : null;
              const newDoc = codesCollection ? await codesCollection.findOne({ user: msNew.toLowerCase() }) : null;
              if (oldDoc && newDoc) {
                linkMsg = "New username already has its own shop link, so the old link was not moved.";
              } else if (oldDoc) {
                await codesCollection.updateOne({ user: msOld.toLowerCase() }, { $set: { user: msNew.toLowerCase() } });
                linkMsg = "Shop link " + oldDoc.code + " now points to @" + msNew + ".";
              }
              const r = await productsCollection.updateMany({ vendor: new RegExp("^" + msOld + "$", "i") }, { $set: { vendor: msNew } });
              await sendMessage(chatId, "✅ Moved " + r.modifiedCount + " listing(s) from @" + msOld + " to @" + msNew + ".\n" + linkMsg + "\nRe-verify the new username if needed and ask the vendor to tap Start on the bot.");
            } catch (e) {
              await sendMessage(chatId, "Could not move the shop.");
            }
          }
        }
      }

      if (text === "/digest") {
        if (!isAdminUser) {
          await sendMessage(chatId, "You're not authorized to use this command.");
        } else {
          await sendMessage(chatId, await buildDigest(Date.now() - DIGEST_DAYS * DAY_MS));
        }
      }

      if (text === "/cancelreport") {
        await usersCollection.updateOne({ chatId }, { $set: { reportDealId: null } });
        await usersCollection.updateOne({ chatId }, { $set: { commentDealId: null } });
        await sendMessage(chatId, "Cancelled.");
      }

      if (text === "/report") {
        const found = await findDealFor(chatId, update.message.reply_to_message);
        if (!found.deal) {
          await sendMessage(chatId, "You have no active chat to report. Open the chat with the vendor first, then send /report.");
        } else if (found.deal.buyerChatId !== chatId) {
          await sendMessage(chatId, `Only buyers can report a vendor. Contact @${SUPPORT_USERNAME} if you need help.`);
        } else {
          await usersCollection.updateOne({ chatId }, { $set: { reportDealId: found.deal.dealId, reportAt: Date.now() } });
          await sendMessage(chatId, `🚩 Reporting ${found.deal.vendorName} about "${found.deal.productName}".\n\nType what went wrong in one message. Send /cancelreport to stop.`);
        }
      }

      if (text === "/enddeal") {
        const found = await findDealFor(chatId, update.message.reply_to_message);
        if (!found.deal) {
          await sendMessage(chatId, found.count > 1 ? "You have more than one active chat. Tap ↩️ Reply under the chat you mean, then send /enddeal." : "You have no active deals.");
        } else {
          const d = found.deal;
          await dealsCollection.updateOne({ dealId: d.dealId }, { $set: { status: "closed", closedAt: Date.now(), closedReason: "ended" } });
          await logDeal(d.dealId, "system", "System", `Deal ended by ${chatId === d.buyerChatId ? "buyer" : "vendor"}`);
          await sendDealMsg(d.buyerChatId, `Chat about "${d.productName}" closed.`, d.dealId);
          await sendDealMsg(d.vendorChatId, `Chat about "${d.productName}" closed.`, d.dealId);
        }
      }

      if (text === "/paid" || text === "/received") {
        const found = await findDealFor(chatId, update.message.reply_to_message);
        if (!found.deal) {
          await sendMessage(chatId, found.count > 1 ? "You have more than one active chat. Tap ↩️ Reply under the chat you mean, then send the command." : "You have no active deals.");
        } else {
          const d = found.deal;
          if (text === "/paid") {
            if (chatId !== d.vendorChatId) await sendMessage(chatId, "Only the vendor can confirm payment.");
            else if (d.paid) await sendMessage(chatId, "Payment is already confirmed.");
            else await markPaid(d);
          } else {
            if (chatId !== d.buyerChatId) await sendMessage(chatId, "Only the buyer can confirm receipt.");
            else if (d.status === "completed") await sendMessage(chatId, "This deal is already completed.");
            else await markReceived(d);
          }
        }
      }

      let reportHandled = false;
      if (!text.startsWith("/") && text && update.message.chat.type === "private") {
        const ru = await usersCollection.findOne({ chatId });
        if (ru && ru.reportDealId && Date.now() - (ru.reportAt || 0) < 10 * 60 * 1000) {
          reportHandled = true;
          const rdl = await dealsCollection.findOne({ dealId: ru.reportDealId });
          await usersCollection.updateOne({ chatId }, { $set: { reportDealId: null } });
          if (rdl) {
            await reportsCollection.insertOne({ dealId: rdl.dealId, vendorName: rdl.vendorName, productName: rdl.productName, buyerChatId: rdl.buyerChatId, reason: text, at: Date.now() });
            await logDeal(rdl.dealId, "system", "System", "Buyer reported a problem: " + text);
            const alertText = `🚩 Vendor report\n\nVendor: ${rdl.vendorName}\nProduct: ${rdl.productName}\nBuyer: ${rdl.buyerName}\nStatus: ${rdl.status}${rdl.paid ? " · paid" : ""}\n\nReason: ${text}\n\nFull chat: /deal ${rdl.dealId}`;
            for (const adminId of ADMIN_IDS) await sendMessage(adminId, alertText);
            await sendMessage(chatId, "Thanks. Your report was sent to the CaliBaz team and we'll look into it.");
          }
        }
      }

      if (!reportHandled && !text.startsWith("/") && text && update.message.chat.type === "private") {
        const cu = await usersCollection.findOne({ chatId });
        if (cu && cu.commentDealId && Date.now() - (cu.commentAt || 0) < 10 * 60 * 1000) {
          reportHandled = true;
          const cd = cu.commentDealId;
          await usersCollection.updateOne({ chatId }, { $set: { commentDealId: null } });
          await ratingsCollection.updateOne({ dealId: cd }, { $set: { comment: text } });
          await logDeal(cd, "system", "System", "Buyer left a rating comment: " + text);
          await sendMessage(chatId, "Thanks for the comment. It goes to the CaliBaz team.");
        }
      }

      if (!reportHandled && !text.startsWith("/") && update.message.chat.type === "private" && !update.message.successful_payment) {
        const found = await findDealFor(chatId, update.message.reply_to_message);
        if (found.deal) {
          const d = found.deal;
          const fromBuyer = chatId === d.buyerChatId;
          const target = fromBuyer ? d.vendorChatId : d.buyerChatId;
          const label = fromBuyer ? d.buyerName : d.vendorName;
          const m = update.message;
          const kind = ["photo", "document", "video", "voice", "audio", "sticker", "video_note", "animation"].find(k => m[k]);
          if (!kind && !m.text) {
            await sendMessage(chatId, "That type of message can't be passed on. Please send text, a photo, or a file.");
          } else {
            await logDeal(d.dealId, fromBuyer ? "buyer" : "vendor", label, m.text || m.caption || "", kind || "text");
            await dealsCollection.updateOne({ dealId: d.dealId }, { $set: { lastActivity: Date.now(), reminded: false } });
            if (!kind) {
              await sendIncoming(target, `💬 ${label} · ${d.productName}:\n${m.text}`, d.dealId);
            } else {
              await sendIncoming(target, `📎 ${label} sent a file · ${d.productName}:`, d.dealId);
              const cp = await (await fetch(`${TELEGRAM_API}/copyMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: target, from_chat_id: chatId, message_id: m.message_id })
              })).json();
              if (cp.ok) await relayCollection.insertOne({ chatId: target, messageId: cp.result.message_id, dealId: d.dealId });
              for (const adminId of ADMIN_IDS) {
                if (adminId !== chatId && adminId !== target) {
                  await sendMessage(adminId, `📎 Deal #${d.dealId} · ${label} sent a file:`);
                  await fetch(`${TELEGRAM_API}/copyMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ chat_id: adminId, from_chat_id: chatId, message_id: m.message_id })
                  });
                }
              }
            }
          }
        } else if (found.count > 1) {
          await sendMessage(chatId, "You have more than one active chat. Tap ↩️ Reply under the message you're answering, then type your reply.");
        } else {
          const had = await dealsCollection.findOne({ $or: [{ buyerChatId: chatId }, { vendorChatId: chatId }] });
          if (had) await sendMessage(chatId, "You have no active deal. Tap I'm Interested in the market to start one.");
        }
      }

      if (text === "/deals" || text.startsWith("/deals ") || text === "/deal" || text.startsWith("/deal ") || text.startsWith("/closedeal")) {
        if (!isAdminUser) {
          await sendMessage(chatId, "You're not authorized to use this command.");
        } else if (text === "/deals" || text.startsWith("/deals ")) {
          const arg = text.replace("/deals", "").trim();
          let page = 1;
          let filter = {};
          if (/^\d+$/.test(arg)) {
            page = Math.max(1, parseInt(arg, 10));
          } else if (["open", "completed", "closed"].includes(arg.toLowerCase())) {
            filter = { status: arg.toLowerCase() };
          } else if (arg) {
            const re = new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            filter = { $or: [{ vendorName: re }, { buyerName: re }, { productName: re }] };
          }
          const total = await dealsCollection.countDocuments(filter);
          const pages = Math.max(1, Math.ceil(total / 15));
          page = Math.min(page, pages);
          const list = await dealsCollection.find(filter).sort({ createdAt: -1 }).skip((page - 1) * 15).limit(15).toArray();
          const next = Object.keys(filter).length === 0 && page < pages ? `\n\nNext page: /deals ${page + 1}` : "";
          await sendMessage(chatId, list.length
            ? `Deals: ${total} · page ${page}/${pages}\n\n` + list.map(d => `#${d.dealId} | ${d.productName} | ${d.buyerName} ↔ ${d.vendorName} | ${d.status}${d.paid ? " | paid" : ""}`).join("\n") + next
            : "No deals found.");
        } else if (text.startsWith("/closedeal")) {
          const id = text.replace("/closedeal", "").trim();
          const deal = id ? await dealsCollection.findOne({ dealId: id }) : null;
          if (!deal) {
            await sendMessage(chatId, "Format:\n/closedeal <id>\nGet ids from /deals");
          } else if (deal.status === "closed") {
            await sendMessage(chatId, "That deal is already closed.");
          } else {
            await dealsCollection.updateOne({ dealId: id }, { $set: { status: "closed", closedAt: Date.now(), closedReason: "admin" } });
            await logDeal(id, "system", "System", "Deal closed by CaliBaz admin");
            const note = `The chat about "${deal.productName}" was closed by CaliBaz support. Contact @${SUPPORT_USERNAME} if you need help.`;
            await sendDealMsg(deal.buyerChatId, note, id);
            await sendDealMsg(deal.vendorChatId, note, id);
            await sendMessage(chatId, "Deal closed.");
          }
        } else {
          const id = text.replace("/deal", "").trim();
          const deal = id ? await dealsCollection.findOne({ dealId: id }) : null;
          if (!deal) {
            await sendMessage(chatId, "Format:\n/deal <id>\nGet ids from /deals");
          } else {
            const msgs = await logCollection.find({ dealId: id }).sort({ at: 1 }).toArray();
            const lines = msgs.map(x => `${new Date(x.at).toISOString().slice(5, 16).replace("T", " ")} ${x.from}: ${x.kind !== "text" ? "[" + x.kind + "] " : ""}${x.text}`);
            const out = `Deal #${deal.dealId} · ${deal.productName}\n${deal.buyerName} ↔ ${deal.vendorName} · ${deal.status}${deal.paid ? " · paid" : ""}\n(times are UTC)\n\n` + (lines.join("\n") || "No messages yet.");
            for (let i = 0; i < out.length; i += 3800) await sendMessage(chatId, out.slice(i, i + 3800));
          }
        }
      }
    } catch (e) {
      console.error("Deal handler error:", e);
    }


    if (text.startsWith("/setad") || text === "/clearad") {
      if (!ADMIN_IDS.includes(update.message.from.id)) {
        await sendMessage(chatId, "You're not authorized to use this command.");
      } else if (text === "/clearad") {
        await adsCollection.deleteOne({ _id: "current" });
        await sendMessage(chatId, "Ad removed.");
      } else {
        const [adText, adUrl] = text.replace("/setad", "").split("|").map(s => s.trim());
        if (!adText || !adUrl || !/^https:\/\//.test(adUrl)) {
          await sendMessage(chatId, "Format:\n/setad Ad text | https://t.me/username");
        } else {
          await adsCollection.updateOne({ _id: "current" }, { $set: { text: adText, url: adUrl, setAt: Date.now() } }, { upsert: true });
          await sendMessage(chatId, "Ad is live ✅");
        }
      }
    }

    if (text === "/faq") {
      await sendMessage(chatId, "Which FAQ do you need?", faqKeyboard());
    }

    if (text.startsWith("/setcategory")) {
      if (!ADMIN_IDS.includes(update.message.from.id)) {
        await sendMessage(chatId, "You're not authorized to use this command.");
      } else {
        const [id, category] = text.replace("/setcategory", "").split("|").map(s => s.trim());
        if (!id || !category) {
          await sendMessage(chatId, "Format:\n/setcategory <id> | Category name");
        } else {
          const r = await productsCollection.updateOne({ id }, { $set: { category } });
          await sendMessage(chatId, r.matchedCount ? "Category updated." : "No product found with that id.");
        }
      }
    }

    if (text.startsWith("/verify") || text.startsWith("/unverify")) {
      if (!ADMIN_IDS.includes(update.message.from.id)) {
        await sendMessage(chatId, "You're not authorized to use this command.");
      } else {
        const isVerify = text.startsWith("/verify");
        const vendor = text.replace(/^\/(un)?verify/, "").trim().replace("@", "").toLowerCase();
        if (!vendor) {
          await sendMessage(chatId, "Format:\n/verify vendorusername\n/unverify vendorusername");
        } else if (isVerify) {
          await verifiedCollection.updateOne({ vendor }, { $set: { vendor } }, { upsert: true });
          await sendMessage(chatId, `Verified: ${vendor} ✅`);
        } else {
          await verifiedCollection.deleteOne({ vendor });
          await sendMessage(chatId, `Verification removed: ${vendor}`);
        }
      }
    }

    if (text === "/listproducts" || text.startsWith("/listproducts ") || text.startsWith("/removeproduct")) {
      if (!ADMIN_IDS.includes(update.message.from.id)) {
        await sendMessage(chatId, "You're not authorized to use this command.");
      } else if (text === "/listproducts" || text.startsWith("/listproducts ")) {
        const q = text.replace("/listproducts", "").trim().toLowerCase().replace("@", "");
          const all = (await loadProducts()).filter(p => !q || [p.vendor, p.vendorName].join(" ").toLowerCase().includes(q));
        if (all.length === 0) {
          await sendMessage(chatId, "No products yet.");
        } else {
          const lines = all.slice(0, 25).map(p => `${p.id} | ${p.name} | ${p.category} | ${p.vendor}`);
          await sendMessage(chatId, lines.join("\n") + (all.length > 25 ? `\n...and ${all.length - 25} more` : ""));
        }
      } else {
        const id = text.replace("/removeproduct", "").trim();
        if (!id) {
          await sendMessage(chatId, "Format:\n/removeproduct <id>\nGet ids from /listproducts");
        } else {
          const result = await productsCollection.deleteOne({ id });
          await sendMessage(chatId, result.deletedCount ? "Product removed." : "No product found with that id.");
        }
      }
    }

    if (text === "/start") {
      await sendMessage(chatId,
        "Welcome to CaliBaz Market! 🛍️\nBrowse categories, order what you need, or become a vendor.",
        mainMenuKeyboard()
      );
    }

    if (text === "/support") {
      await sendMessage(chatId,
        "Need help? Tap below to chat with our support team.",
        supportKeyboard()
      );
    }

    if (text === "/becomevendor" || text === "/start become_vendor") {
      const userId = update.message.from.id;
      const joined = await isChannelMember(userId);
      if (joined) {
        await sendMessage(chatId, "Which category will you be selling in?", vendorCategoryKeyboard());
      } else {
        await sendMessage(chatId,
          "Please join our channel first to become a vendor 👇",
          joinChannelKeyboard()
        );
      }
    }

    if (text.startsWith("/addproduct")) {
      const userId = update.message.from.id;
      if (!ADMIN_IDS.includes(userId)) {
        await sendMessage(chatId, "You're not authorized to use this command.");
      } else {
        const parts = text.replace("/addproduct", "").split("|").map(p => p.trim());
        if (parts.length < 6) {
          await sendMessage(chatId,
            "Format:\n/addproduct Category | Name | Price | Description | vendorusername | Vendor Display Name"
          );
        } else {
          const [category, name, price, description, vendor, vendorName] = parts;
          const force = (parts[6] || "").toLowerCase() === "force";
          const handle = (vendor || "").replace("@", "").toLowerCase();
          const started = handle ? await usersCollection.findOne({ username: handle }) : null;
          if (!started && !force) {
            await sendMessage(chatId, `⚠️ ${vendorName} (@${handle}) hasn't started @CaliBazbot yet, so buyers can't reach them through deal chats.\n\nForward them this link and ask them to tap Start:\nhttps://t.me/CaliBazbot?start=vendor\n\nThen run /addproduct again.\n\nTo list them anyway (buyers get a direct chat link instead), add | force at the end.`);
          } else try {
            await saveProduct({
              id: Date.now().toString(),
              category, name, price, description, vendor, vendorName,
              image: (update.message.photo ? update.message.photo[update.message.photo.length - 1].file_id : null)
            });
            await sendMessage(chatId, `Product added: ${name} (${category}) by ${vendorName}`);
          } catch (err) {
            await sendMessage(chatId, "Error saving product. Please try again.");
          }
        }
      }
    }
  }

  if (update.callback_query) {
    const chatId = update.callback_query.message.chat.id;
    const data = update.callback_query.data;
    try {
      const cbUser = update.callback_query.from;
      if (cbUser && !cbUser.is_bot) {
        await usersCollection.updateOne(
          { chatId: cbUser.id },
          { $set: { chatId: cbUser.id, username: (cbUser.username || "").toLowerCase(), name: cbUser.first_name || "" } },
          { upsert: true }
        );
      }
      if (data.startsWith("rpt_")) {
        const rptId = data.slice(4);
        const rdd = await dealsCollection.findOne({ dealId: rptId });
        if (!rdd || cbUser.id !== rdd.buyerChatId) {
          await sendMessage(chatId, "Only the buyer can report this deal.");
        } else {
          await usersCollection.updateOne({ chatId: cbUser.id }, { $set: { reportDealId: rptId, reportAt: Date.now() } });
          await sendMessage(chatId, `🚩 Reporting ${rdd.vendorName} about "${rdd.productName}".\n\nType what went wrong in one message. Send /cancelreport to stop.`);
        }
      }

      if (data.startsWith("rc_")) {
        const rcId = data.slice(3);
        const rcd = await dealsCollection.findOne({ dealId: rcId });
        if (!rcd || cbUser.id !== rcd.buyerChatId) {
          await sendMessage(chatId, "Only the buyer can comment on this deal.");
        } else {
          await usersCollection.updateOne({ chatId: cbUser.id }, { $set: { commentDealId: rcId, commentAt: Date.now() } });
          await sendMessage(chatId, `💬 Type your comment about ${rcd.vendorName} in one message. Only the CaliBaz team sees it. Send /cancelreport to stop.`);
        }
      }

      if (data.startsWith("rt_")) {
        const parts2 = data.split("_");
        const rtDeal = parts2[1];
        const stars = parseInt(parts2[2], 10);
        const rd2 = await dealsCollection.findOne({ dealId: rtDeal });
        if (!rd2 || cbUser.id !== rd2.buyerChatId || !(stars >= 1 && stars <= 5)) {
          await sendMessage(chatId, "Only the buyer can rate this deal.");
        } else {
          const prod = await productsCollection.findOne({ id: rd2.productId });
          const key = ((prod && prod.vendor) || rd2.vendorName || "").replace("@", "").toLowerCase();
          const prevRt = await ratingsCollection.findOne({ dealId: rtDeal });
          const rtLocked = !!prevRt && Date.now() - (prevRt.firstAt || prevRt.at || 0) > 10 * 60 * 1000;
          if (!rtLocked) await ratingsCollection.updateOne({ dealId: rtDeal }, { $set: { dealId: rtDeal, vendor: key, stars, at: Date.now() }, $setOnInsert: { firstAt: Date.now() } }, { upsert: true });
          if (rtLocked) {
            await sendMessage(chatId, "You've already rated this deal. Ratings lock 10 minutes after you submit.");
          } else if (stars <= 2) {
            await sendMessage(chatId, `You rated ${rd2.vendorName} ${stars}⭐. Sorry it fell short. Want to tell the CaliBaz team what went wrong?`, { inline_keyboard: [[{ text: "🚩 Report a problem", callback_data: `rpt_${rtDeal}` }]] });
          } else {
            await sendMessage(chatId, `Thanks! You rated ${rd2.vendorName} ${stars}⭐`, { inline_keyboard: [[{ text: "💬 Add a comment", callback_data: `rc_${rtDeal}` }]] });
          }
        }
      }

      if (data.startsWith("rp_")) {
        const rpId = data.slice(3);
        const rd = await dealsCollection.findOne({ dealId: rpId });
        if (!isActive(rd) || (cbUser.id !== rd.buyerChatId && cbUser.id !== rd.vendorChatId)) {
          await sendMessage(chatId, "This chat is closed.");
        } else {
          await usersCollection.updateOne({ chatId: cbUser.id }, { $set: { activeDealId: rpId } });
          await sendMessage(chatId, `↩️ Replying about "${rd.productName}". Type your message now.`);
        }
      }
      if (data.startsWith("dp_") || data.startsWith("dr_")) {
        const dealId = data.slice(3);
        const d = await dealsCollection.findOne({ dealId });
        if (!isActive(d)) {
          await sendMessage(chatId, "This deal is closed.");
        } else if (data.startsWith("dp_")) {
          if (cbUser.id !== d.vendorChatId) await sendMessage(chatId, "Only the vendor can confirm payment.");
          else if (d.paid) await sendMessage(chatId, "Payment is already confirmed.");
          else await markPaid(d);
        } else {
          if (cbUser.id !== d.buyerChatId) await sendMessage(chatId, "Only the buyer can confirm receipt.");
          else if (d.status === "completed") await sendMessage(chatId, "This deal is already completed.");
          else await markReceived(d);
        }
      }
    } catch (e) {
      console.error("Deal callback error:", e);
    }


    if (data === "faq") {
      await sendMessage(chatId, "Which FAQ do you need?", faqKeyboard());
    }
    if (data === "faq_buyers") {
      await sendHtml(chatId, FAQ_BUYERS);
    }
    if (data === "faq_vendors") {
      await sendHtml(chatId, FAQ_VENDORS);
    }

    if (data === "become_vendor") {
      const userId = update.callback_query.from.id;
      const joined = await isChannelMember(userId);
      if (joined) {
        await sendMessage(chatId, "Which category will you be selling in?", vendorCategoryKeyboard());
      } else {
        await sendMessage(chatId,
          "Please join our channel first to become a vendor 👇",
          joinChannelKeyboard()
        );
      }
    }

    if (data.startsWith("vc_")) {
      const index = parseInt(data.replace("vc_", ""), 10);
      const category = CATEGORIES[index];
      if (index === LAND_HOUSING_INDEX) {
        await sendMessage(chatId,
          `🏠 Great news! ${category} listings are free right now.\n\nTap below to chat with admin and share your listing details.`,
          adminChatKeyboard()
        );
      } else {
        await sendInvoice(chatId);
      }
    }

    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: update.callback_query.id })
    });
  }

  if (update.message && update.message.successful_payment) {
    const chatId = update.message.chat.id;
    await sendMessage(chatId,
      "Payment received! ✅ You're now a vendor.\n\nTap below to send us your product details (name, price, description, images) so we can list it.",
      adminChatKeyboard()
    );
  }

  if (update.pre_checkout_query) {
    await fetch(`${TELEGRAM_API}/answerPreCheckoutQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pre_checkout_query_id: update.pre_checkout_query.id,
        ok: true
      })
    });
  }

  res.sendStatus(200);
});

async function sendMessage(chatId, text, keyboard) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      reply_markup: keyboard
    })
  });
}

async function sendInvoice(chatId) {
  await fetch(`${TELEGRAM_API}/sendInvoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      title: "CaliBaz Vendor Listing",
      description: "One-time fee to unlock your vendor listing on CaliBaz Market.",
      payload: "vendor_listing_fee",
      currency: "XTR",
      prices: [{ label: "Vendor Listing Fee", amount: VENDOR_FEE_STARS }]
    })
  });
}

async function isChannelMember(userId) {
  const res = await fetch(`${TELEGRAM_API}/getChatMember?chat_id=@${CHANNEL_USERNAME}&user_id=${userId}`);
  const data = await res.json();
  if (!data.ok) return false;
  const status = data.result.status;
  return status === "member" || status === "administrator" || status === "creator";
}

function joinChannelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📢 Join CaliBaz Channel", url: `https://t.me/${CHANNEL_USERNAME}` }],
      [{ text: "✅ I've Joined - Try Again", callback_data: "become_vendor" }]
    ]
  };
}

function vendorCategoryKeyboard() {
  return {
    inline_keyboard: CATEGORIES.map((cat, i) => (
      [{ text: cat, callback_data: `vc_${i}` }]
    ))
  };
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛒 Open Market", web_app: { url: "https://1fission.github.io/calibaz-market/" } }],
      [{ text: "💼 Become a Vendor", callback_data: "become_vendor" }],
      [{ text: "❓ FAQ", callback_data: "faq" }],
      [{ text: "🆘 Support", url: `https://t.me/${SUPPORT_USERNAME}` }]
    ]
  };
}

function supportKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Chat with Support", url: `https://t.me/${SUPPORT_USERNAME}` }]
    ]
  };
}

function adminChatKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Chat with Admin", url: `https://t.me/${SUPPORT_USERNAME}` }]
    ]
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

app.get("/image/:fileId", async (req, res) => {
  try {
    const info = await (await fetch(`${TELEGRAM_API}/getFile?file_id=${encodeURIComponent(req.params.fileId)}`)).json();
    if (!info.ok) return res.sendStatus(404);
    const img = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`);
    res.set("Content-Type", img.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(await img.arrayBuffer()));
  } catch (e) {
    res.sendStatus(500);
  }
});

const FAQ_BUYERS = `<b>CaliBaz Market FAQ: Buyers</b>

<b>How do I browse?</b>
Open the market, then pick a category, a vendor, then a product. Or use the search box at the top.

<b>Does it cost anything to buy?</b>
No. Browsing and contacting vendors is free.

<b>How do I order?</b>
Tap "I'm Interested" on a product. It opens a private chat with the vendor inside this bot. Agree on price, payment, and any customization there.

<b>How do I pay?</b>
You pay the vendor directly, outside the bot. When the vendor confirms your payment, you'll get a "📦 I received it" button. Tap it once your order arrives to complete the deal.

<b>I have several chats open.</b>
Tap "↩️ Reply" under the message you're answering, then type your reply.

<b>Are the chats private?</b>
Deal chats are recorded and can be read by the CaliBaz team for escrow and dispute resolution. No one else can see them. Never share passwords or card details.

<b>Can I use escrow?</b>
Yes. Contact support (@FissionHelp) before you pay. Escrow is free for now.

<b>What does the ✅ mean?</b>
CaliBaz has vetted that vendor. It's a sign of trust, not a guarantee. The ⭐ number is the average rating from buyers.

<b>Can I rate a vendor?</b>
Yes. After you tap "I received it", the bot asks for a 1-5 star rating. Vendor averages show next to their name in the market. You can change your rating for 10 minutes, then it locks.

<b>Do I need to join the channel?</b>
Yes. To chat with a vendor you must join @CalibazHQ first. The bot will remind you if you haven't.

<b>How long does a chat stay open?</b>
A chat closes 7 days after the deal is completed, or after 14 days with no messages (you get a reminder first). You can start a new one any time by tapping "I'm Interested".

<b>Market slow to open?</b>
The first load after a quiet period can take up to a minute. Wait, or close and reopen.

<b>Problem with a vendor?</b>
Tap "🚩 Report a problem" under your chat messages, or send /report. Type what went wrong and the CaliBaz team will look into it. Only the team sees reports.

<b>Problem with an order?</b>
Message support: @FissionHelp`;

const FAQ_VENDORS = `<b>CaliBaz Market FAQ: Vendors</b>

<b>How do I become a vendor?</b>
Tap "Become a Vendor" in the main menu. You must join our channel @CalibazHQ first.

<b>What does it cost?</b>
A one-time fee of 57 Telegram Stars. Land &amp; Housing listings are free for now.

<b>I don't have Telegram Stars.</b>
Buy them in CaliBaz Market: open the Digital Services category and choose the Telegram Stars listing. You can also buy directly in Telegram, but it can cost more depending on your region because of local taxes.

<b>What happens after I pay?</b>
You get a "Chat with Admin" button. Send your product name, price, description, and photos, and our team lists it for you.

<b>Can I list products myself?</b>
Not yet. Our team adds listings so they look right and go live quickly.

<b>How do buyers reach me?</b>
When a buyer taps "I'm Interested", the bot opens a private deal chat between you and the buyer. Their messages arrive in this bot. Tap "↩️ Reply" under a message to answer that buyer, then type your reply.

<b>Important: tap Start on this bot.</b>
If you haven't started this bot, buyers can't reach you through deal chats and get a direct chat link instead. Open this link and tap Start once: https://t.me/CaliBazbot?start=vendor
Listings can only be added after you've tapped Start.

<b>How do I confirm payment?</b>
Agree on payment in the deal chat. Once you've been paid, tap "✅ Payment received". The buyer then confirms with "📦 I received it" and the deal is complete.

<b>Are the chats private?</b>
Deal chats are recorded and can be read by the CaliBaz team for escrow and dispute resolution. No one else can see them.

<b>Do you offer escrow?</b>
Yes. Contact support (@FissionHelp). Escrow is free for now.

<b>Will I be rated?</b>
Yes. Buyers rate you after each completed deal, and your average shows next to your name. Deliver well and it builds trust.

<b>How do I get the ✅?</b>
The team gives it after vetting. Ask @FissionHelp.

<b>Change or remove a listing?</b>
Message @FissionHelp with the product name and the change.`;

async function sendHtml(chatId, html, keyboard) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", reply_markup: keyboard })
  });
}

function faqKeyboard() {
  return {
    inline_keyboard: [[
      { text: "🛍️ For Buyers", callback_data: "faq_buyers" },
      { text: "💼 For Vendors", callback_data: "faq_vendors" }
    ]]
  };
}

app.get("/ad", async (req, res) => {
  try {
    const ad = await adsCollection.findOne({ _id: "current" });
    res.json(ad ? { text: ad.text, url: ad.url } : null);
  } catch (e) {
    res.json(null);
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 7;

function activeFilter() {
  return { $or: [{ status: "open" }, { status: "completed", completedAt: { $gt: Date.now() - GRACE_DAYS * DAY_MS } }] };
}

function isActive(d) {
  if (!d) return false;
  if (d.status === "open") return true;
  return d.status === "completed" && Date.now() - (d.completedAt || 0) < GRACE_DAYS * DAY_MS;
}

async function sendDealMsg(chatId, text, dealId, keyboard) {
  try {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: keyboard })
    });
    const d = await r.json();
    if (d.ok && dealId) await relayCollection.insertOne({ chatId, messageId: d.result.message_id, dealId });
    return d.ok;
  } catch (e) {
    return false;
  }
}

async function logDeal(dealId, role, from, text, kind) {
  await logCollection.insertOne({ dealId, role, from, text: text || "", kind: kind || "text", at: Date.now() });
}

async function findDealFor(uid, replied) {
  if (replied) {
    const map = await relayCollection.findOne({ chatId: uid, messageId: replied.message_id });
    if (map) {
      const d = await dealsCollection.findOne({ dealId: map.dealId });
      if (isActive(d) && (d.buyerChatId === uid || d.vendorChatId === uid)) {
        await usersCollection.updateOne({ chatId: uid }, { $set: { activeDealId: d.dealId } });
        return { deal: d, count: 1 };
      }
    }
  }
  const user = await usersCollection.findOne({ chatId: uid });
  if (user && user.activeDealId) {
    const a = await dealsCollection.findOne({ dealId: user.activeDealId });
    if (isActive(a) && (a.buyerChatId === uid || a.vendorChatId === uid)) return { deal: a, count: 1 };
  }
  const mine = await dealsCollection.find({ $and: [activeFilter(), { $or: [{ buyerChatId: uid }, { vendorChatId: uid }] }] }).toArray();
  if (mine.length === 1) return { deal: mine[0], count: 1 };
  return { deal: null, count: mine.length };
}

async function markPaid(d) {
  await dealsCollection.updateOne({ dealId: d.dealId }, { $set: { paid: true, paidAt: Date.now() } });
  await logDeal(d.dealId, "system", "System", "Vendor confirmed payment received");
  await sendDealMsg(d.vendorChatId, `✅ Payment confirmed for "${d.productName}". Arrange delivery here.`, d.dealId);
  await sendDealMsg(d.buyerChatId, `✅ ${d.vendorName} confirmed your payment for "${d.productName}". When your order arrives, tap the button below.`, d.dealId, {
    inline_keyboard: [[{ text: "📦 I received it", callback_data: `dr_${d.dealId}` }], [{ text: "🚩 Report a problem", callback_data: `rpt_${d.dealId}` }]]
  });
}

async function markReceived(d) {
  await dealsCollection.updateOne({ dealId: d.dealId }, { $set: { status: "completed", completedAt: Date.now() } });
  await logDeal(d.dealId, "system", "System", "Buyer confirmed receipt: deal completed");
  const note = `🎉 "${d.productName}" deal completed. You can still message here for ${GRACE_DAYS} days, then this chat closes.`;
  await sendDealMsg(d.buyerChatId, note, d.dealId);
  await sendDealMsg(d.vendorChatId, note, d.dealId);
  try {
    await sendDealMsg(d.buyerChatId, `⭐ How was your experience with ${d.vendorName}? Tap a rating:`, d.dealId, { inline_keyboard: [[1, 2, 3, 4, 5].map(n => ({ text: `${n}⭐`, callback_data: `rt_${d.dealId}_${n}` }))] });
  } catch (e) { console.error(e); }
}

async function alertAdminsOnce(vendorHandle, text) {
  const key = vendorHandle.toLowerCase();
  const prev = await alertsCollection.findOne({ vendor: key });
  if (prev && Date.now() - prev.at < DAY_MS) return;
  await alertsCollection.updateOne({ vendor: key }, { $set: { vendor: key, at: Date.now() } }, { upsert: true });
  for (const adminId of ADMIN_IDS) await sendMessage(adminId, text);
}

const STALE_DAYS = 14;
const REMIND_DAYS = 12;

async function sendDirectLink(chatId, vendorHandle, vendorLabel, product) {
  await sendMessage(chatId, `Tap below to chat with ${vendorLabel} directly 👇`, {
    inline_keyboard: [[{ text: "💬 Chat with vendor", url: `https://t.me/${vendorHandle}?text=${encodeURIComponent("Hi, I am interested in " + product.name + " on CaliBaz Market.")}` }]]
  });
  await alertAdminsOnce(vendorHandle, `⚠️ A buyer wanted to chat with ${vendorHandle} about "${product.name}", but they haven't started the bot. Ask them to open @CaliBazbot and tap Start.`);
}

async function checkStaleDeals() {
  const now = Date.now();
  const open = await dealsCollection.find({ status: "open" }).toArray();
  for (const d of open) {
    const idle = now - (d.lastActivity || d.createdAt || now);
    if (idle >= STALE_DAYS * DAY_MS) {
      await dealsCollection.updateOne({ dealId: d.dealId }, { $set: { status: "closed", closedAt: now, closedReason: "inactive" } });
      await logDeal(d.dealId, "system", "System", `Closed automatically after ${STALE_DAYS} days without messages`);
      const note = `The chat about "${d.productName}" was closed after ${STALE_DAYS} days without messages. Tap I'm Interested in the market to start a new one.`;
      await sendDealMsg(d.buyerChatId, note, d.dealId);
      await sendDealMsg(d.vendorChatId, note, d.dealId);
    } else if (idle >= REMIND_DAYS * DAY_MS && !d.reminded) {
      await dealsCollection.updateOne({ dealId: d.dealId }, { $set: { reminded: true } });
      const note = `Your chat about "${d.productName}" closes in ${STALE_DAYS - REMIND_DAYS} days. Send any message to keep it open.`;
      await sendDealMsg(d.buyerChatId, note, d.dealId);
      await sendDealMsg(d.vendorChatId, note, d.dealId);
    }
  }
}

setInterval(() => checkStaleDeals().catch(e => console.error(e)), 6 * 60 * 60 * 1000);
setTimeout(() => checkStaleDeals().catch(e => console.error(e)), 60 * 1000);

async function sendIncoming(chatId, text, dealId) {
  const ok = await sendDealMsg(chatId, text, dealId, { inline_keyboard: [[{ text: "↩️ Reply", callback_data: `rp_${dealId}` }]] });
  await usersCollection.updateOne({ chatId, activeDealId: { $nin: [null, dealId] } }, { $set: { activeDealId: null } });
  return ok;
}

const DIGEST_DAYS = 3;

async function buildDigest(since) {
  const days = Math.max(1, Math.round((Date.now() - since) / DAY_MS));
  const newDeals = await dealsCollection.countDocuments({ createdAt: { $gte: since } });
  const paid = await dealsCollection.countDocuments({ paidAt: { $gte: since } });
  const done = await dealsCollection.countDocuments({ completedAt: { $gte: since } });
  const openNow = await dealsCollection.countDocuments({ status: "open" });
  const msgs = await logCollection.countDocuments({ at: { $gte: since }, role: { $in: ["buyer", "vendor"] } });
  const rts = await ratingsCollection.find({ at: { $gte: since } }).toArray();
  const avg = rts.length ? (rts.reduce((a, r) => a + r.stars, 0) / rts.length).toFixed(1) : null;
  const prods = await productsCollection.find({}).toArray();
  const handles = [...new Set(prods.map(p => (p.vendor || "").replace("@", "").toLowerCase()).filter(Boolean))];
  const started = await usersCollection.find({ username: { $in: handles } }).toArray();
  const startedSet = new Set(started.map(u => u.username));
  const notStarted = handles.filter(h => !startedSet.has(h)).length;
  return [
    "🗓 CaliBaz digest · last " + days + (days === 1 ? " day" : " days"),
    "",
    "New deals: " + newDeals,
    "Payments confirmed: " + paid,
    "Deals completed: " + done,
    "Messages relayed: " + msgs,
    "New ratings: " + (avg ? rts.length + " (avg ⭐ " + avg + ")" : "0"),
    "",
    "Open deals now: " + openNow,
    "Vendors not started: " + notStarted
  ].join("\n");
}

async function checkDigest() {
  const doc = await alertsCollection.findOne({ vendor: "__digest__" });
  const last = doc ? doc.at : 0;
  if (Date.now() - last < DIGEST_DAYS * DAY_MS) return;
  const since = last || Date.now() - DIGEST_DAYS * DAY_MS;
  const text = await buildDigest(since);
  await alertsCollection.updateOne({ vendor: "__digest__" }, { $set: { vendor: "__digest__", at: Date.now() } }, { upsert: true });
  for (const adminId of ADMIN_IDS) await sendMessage(adminId, text);
}

setInterval(() => checkDigest().catch(e => console.error(e)), 60 * 60 * 1000);
setTimeout(() => checkDigest().catch(e => console.error(e)), 90 * 1000);

var shareCollection;
var codesCollection;
app.get("/shopcode", async (req, res) => {
  try {
    const u = String(req.query.u || "").replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{3,40}$/.test(u) || !codesCollection) return res.json({});
    let doc = await codesCollection.findOne({ user: u });
    if (!doc) {
      const abc = "abcdefghjkmnpqrstuvwxyz23456789";
      let code = "";
      for (let tries = 0; tries < 10; tries++) {
        const bytes = require("crypto").randomBytes(6);
        code = Array.from(bytes).map(b => abc[b % abc.length]).join("");
        if (!(await codesCollection.findOne({ code }))) break;
      }
      doc = { user: u, code };
      await codesCollection.insertOne(doc);
    }
    return res.json({ code: doc.code });
  } catch (e) { return res.json({}); }
});

app.get("/share/event", async (req, res) => {
  try {
    const id = String(req.query.id || "").slice(0, 60);
    if (id && shareCollection) await shareCollection.insertOne({ productId: id, at: Date.now() });
  } catch (e) {}
  res.json({ ok: true });
});

app.get("/ad/event", async (req, res) => {
  try {
    const type = req.query.type === "click" ? "click" : "view";
    let uid = "anon";
    try {
      const u = JSON.parse(new URLSearchParams(req.headers["x-init-data"] || "").get("user") || "{}");
      if (u && u.id) uid = String(u.id);
    } catch (e) {}
    if (type === "view") uid = "all";
    const ad = await adsCollection.findOne({ _id: "current" });
    if (ad && ad.text) await adEventsCollection.updateOne({ adId: ad.setAt || 0, uid, type }, { $inc: { count: 1 }, $set: { at: Date.now() } }, { upsert: true });
  } catch (e) {}
  res.json({ ok: true });
});
