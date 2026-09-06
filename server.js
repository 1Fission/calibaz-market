const express = require("express");
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SUPPORT_USERNAME = "FissionHelp";
const VENDOR_FEE_STARS = 57;
const CHANNEL_USERNAME = "CalibazHQ";

// Health check - lets us confirm the server is running
app.get("/", (req, res) => {
  res.send("CaliBaz Market backend is running.");
});

// Telegram sends all bot updates here
app.post("/webhook", async (req, res) => {
  const update = req.body;

  // Handle regular messages (commands)
  if (update.message) {
    const chatId = update.message.chat.id;
    const text = update.message.text || "";

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
      await sendInvoice(chatId);
    }
  }

// Handle button taps (like "Become a Vendor")
  if (update.callback_query) {
    const chatId = update.callback_query.message.chat.id;
    const data = update.callback_query.data;

    if (data === "become_vendor") {
      const userId = update.callback_query.from.id;
      const joined = await isChannelMember(userId);
      if (joined) {
        await sendInvoice(chatId);
      } else {
        await sendMessage(chatId,
          "Please join our channel first to become a vendor 👇",
          joinChannelKeyboard()
        );
      }
    }

    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: update.callback_query.id })
    });
  }
  // Handle successful payments
  if (update.message && update.message.successful_payment) {
    const chatId = update.message.chat.id;
    await sendMessage(chatId,
      "Payment received! ✅ You're now a vendor.\n\nTap below to send us your product details (name, price, description, images) so we can list it.",
      adminChatKeyboard()
    );
  }

  // Handle pre-checkout (Telegram requires confirming the invoice before charging)
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
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛒 Open Market", web_app: { url: "https://1fission.github.io/calibaz-market/" } }],
      [{ text: "💼 Become a Vendor (57 Stars)", callback_data: "become_vendor" }],
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

