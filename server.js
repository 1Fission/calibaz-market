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
  "Fruit Juice & Related Products",
  "Cake & Related Products",
  "Herbarium & Herbal Products",
  "Land & Housing",
  "Fashion & Apparel",
  "Home & Lifestyle",
  "Electronics & Gadgets",
  "Beauty & Personal Care",
  "Digital Services",
  "Food & Related Products",
  "Custom/Handmade Requests"
];
const LAND_HOUSING_INDEX = 3;

const { MongoClient } = require("mongodb");
const MONGO_URI = process.env.MONGO_URI;
const client = new MongoClient(MONGO_URI);
let productsCollection, verifiedCollection;

async function connectDB() {
  await client.connect();
  const db = client.db("calibaz");
  productsCollection = db.collection("products");
  verifiedCollection = db.collection("verified_vendors");
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
    const isAdmin = isAdminInitData(req.headers["x-init-data"] || ""); const vv = (await verifiedCollection.find({}).toArray()).map(v => v.vendor); res.json(products.filter(p => isAdmin || p.category !== TEST_CATEGORY).map(p => ({ ...p, verified: vv.includes((p.vendor || "").toLowerCase()) })));
  } catch (err) {
    res.status(500).json({ error: "Could not load products" });
  }
});

app.post("/webhook", async (req, res) => {
  const update = req.body;

  if (update.message) {
    const chatId = update.message.chat.id;
    const text = update.message.text || update.message.caption || "";

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

    if (text === "/listproducts" || text.startsWith("/removeproduct")) {
      if (!ADMIN_IDS.includes(update.message.from.id)) {
        await sendMessage(chatId, "You're not authorized to use this command.");
      } else if (text === "/listproducts") {
        const all = await loadProducts();
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

    if (text === "/becomevendor") {
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
          try {
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
Open the market, then pick a category, a vendor, then a product.

<b>Does it cost anything to buy?</b>
No. Browsing and contacting vendors is free.

<b>How do I order?</b>
Tap "I'm Interested" on a product. It opens a chat with the vendor to agree on price, payment, and any customization.

<b>How do I pay?</b>
You pay the vendor directly, outside the bot. Once they confirm payment, arrange delivery or pickup in the same chat.

<b>Can I use escrow?</b>
Yes. Contact support (@FissionHelp) before you pay. Escrow is free for now.

<b>What does the ✅ mean?</b>
CaliBaz has vetted that vendor. It's a sign of trust, not a guarantee.

<b>Market slow to open?</b>
The first load after a quiet period can take up to a minute. Wait, or close and reopen.

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
When a buyer taps "I'm Interested", a chat opens with you. Agree on payment and delivery there, and confirm once you're paid.

<b>Do you offer escrow?</b>
Yes. Contact support (@FissionHelp). Escrow is free for now.

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
