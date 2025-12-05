# 📱 How to Connect Your WhatsApp Number to the Bot

## ✅ What Just Happened

Your bot is **successfully running**! The logs show:
- ✅ Gemini AI initialized
- ✅ Health server running on port 3000
- ✅ WhatsApp client connected and generating QR code
- ✅ Bot is ready and listening for messages

## 🔄 **NOW: Restart Your Bot to See the QR Code**

I've updated the code to display the QR code properly. Here's what to do:

### **Step 1: Restart the Bot**

Since you stopped it with Ctrl+C, restart it now:

```bash
npm run dev
```

### **Step 2: You'll See This**

```
============================================================
📱 SCAN THIS QR CODE WITH YOUR WHATSAPP
============================================================

█████████████████████████████████████
█████████████████████████████████████
████ ▄▄▄▄▄ █▀█ █▄▄▀▄▀▄█ ▄▄▄▄▄ ████
████ █   █ █▀▀▀█  ▀█ ▀█ █   █ ████
████ █▄▄▄█ █▀ █▀▀▀▄███ █▄▄▄█ ████
... (QR code pattern) ...

============================================================
📲 Open WhatsApp → Settings → Linked Devices → Link a Device
============================================================
```

### **Step 3: Scan the QR Code**

On your phone:

1. **Open WhatsApp**
2. Go to **Settings** (⚙️)
3. Tap **Linked Devices**
4. Tap **Link a Device**
5. **Scan the QR code** from your terminal
6. Wait for confirmation

### **Step 4: Success! You'll See:**

```
✅ WhatsApp connection established successfully!
📱 Connected as: Your Name
```

---

## ❓ **What Happens After Scanning?**

### ✅ Your Phone Number Becomes the Bot

- The WhatsApp number you use to scan = the bot's number
- The bot will receive messages sent to that number
- In groups, the bot responds when mentioned with `@bot`
- In private chats, the bot responds to all messages

### 🔐 Session Saved Automatically

After scanning once:
- Session is saved in `auth_info_baileys/` folder
- Next time you run the bot, **no QR code needed**
- Bot automatically logs in with saved session

---

## 📋 **Testing After Connection**

### **Test 1: Check Bot Status**

Message yourself (the bot's number) from another phone or WhatsApp Web:

```
!status
```

**Expected Response:**
```
🤖 Bot Status

📊 Memory: 0 messages
⏰ Window: 60 minutes
🧠 LLM: gemini (gemini-1.5-flash)
👥 Admins: 2

System Prompt:
"You are a helpful AI assistant..."
```

### **Test 2: Talk to the Bot**

```
You: Hello bot!
Bot: Hi there! How can I help you today?
```

### **Test 3: In a Group**

1. Add the bot's number to a WhatsApp group
2. Send: `@bot what is TypeScript?`
3. Bot will respond with AI-generated answer

---

## 🔧 **Important Configuration**

### **Update Your Admin Number**

Edit `.env` and replace the example admin numbers with YOUR actual WhatsApp number:

```bash
# Format: country code + number (no + or spaces)
# Example for +1 (234) 567-8900 → use: 1234567890
ADMIN_NUMBERS=1234567890,9876543210
```

**How to find your WhatsApp number:**
1. Open WhatsApp
2. Go to Settings → Profile
3. Your number is shown there
4. Format it: Remove `+`, spaces, dashes, parentheses

**Examples:**
- ✅ `1234567890` (USA)
- ✅ `447911123456` (UK)
- ✅ `91987654321` (India)
- ❌ `+1 (234) 567-8900` (Wrong format!)

---

## 🎯 **What This Bot Can Do Now**

### ✅ **In Private Chats**
- Responds to every message with AI
- Maintains conversation context
- Remembers last hour of conversation

### ✅ **In Groups**
- Only responds when mentioned: `@bot your question`
- Stores all group messages for context
- Can understand group conversation flow

### ✅ **Admin Commands** (only you can use)
```bash
!help        # Show commands
!status      # Bot info & stats
!clear       # Clear memory
!system      # Change AI behavior
```

---

## 🐛 **Troubleshooting**

### **QR Code Still Not Showing?**

1. Make sure you restarted the bot AFTER my code changes
2. Check terminal supports UTF-8
3. Try: `export LANG=en_US.UTF-8` then `npm run dev`

### **Connection Closed Immediately?**

- WhatsApp might be rate limiting
- Wait 5 minutes and try again
- Make sure no other WhatsApp Web is connected

### **"Not Logged In"**

This is normal! It means:
- Bot is ready to show QR code
- Waiting for you to scan
- Nothing is wrong

### **Already Scanned But Disconnected?**

The logs show you're "not logged in, attempting registration..." which means:
- This is the first time connecting, OR
- Previous session expired

Just scan the QR code and it will connect!

---

## 📁 **Files Created**

I've added:
- ✅ `src/types/qrcode-terminal.d.ts` - TypeScript types
- ✅ Updated `src/services/whatsapp.service.ts` - QR code display
- ✅ Installed `qrcode-terminal` package

---

## 🚀 **Quick Start Summary**

```bash
# 1. Restart the bot (if stopped)
npm run dev

# 2. You'll see a QR code in the terminal

# 3. Scan it with WhatsApp on your phone
#    Settings → Linked Devices → Link a Device

# 4. Wait for: "✅ WhatsApp connection established successfully!"

# 5. Test it: Send a message to the bot's number

# 6. Enjoy your AI WhatsApp bot! 🎉
```

---

## 💡 **Pro Tips**

1. **First Connection**: After scanning, wait 10-20 seconds for full sync
2. **Session Persistence**: Don't delete `auth_info_baileys/` folder
3. **Multiple Devices**: Bot works alongside your normal WhatsApp
4. **Testing**: Use WhatsApp Web to test messaging yourself
5. **Logs**: Check `logs/combined.log` if anything goes wrong

---

## ❗ **IMPORTANT**

### **Which Number is the Bot?**

👉 **The bot uses the WhatsApp number you scan with!**

- If you scan with your personal number → your personal number becomes the bot
- If you scan with a business number → business number becomes the bot
- If you want a separate bot number → use a different phone/SIM to scan

### **Can I Use My Main WhatsApp?**

⚠️ **Not recommended** because:
- Bot will respond to ALL messages automatically
- Your personal chats will get AI responses
- Admin commands might confuse contacts

**Better Options:**
1. Use WhatsApp Business (separate number)
2. Get a second SIM card for the bot
3. Use a virtual number service

---

## ✅ **You're Ready!**

Just run `npm run dev` and scan the QR code that appears! 🚀
