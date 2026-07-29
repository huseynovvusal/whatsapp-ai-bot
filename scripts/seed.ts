/**
 * Fixtures / demo-data seeder.
 *
 *   npm run seed              # add ~90 days of demo data
 *   npm run seed -- --days 30 # shorter window
 *   npm run seed -- --reset   # remove demo data, then re-seed
 *   npm run seed -- --clean   # remove demo data and exit
 *
 * Everything this script writes is namespaced behind `demo`/`999000` identifiers
 * (see IS_DEMO_SQL below), so `--reset` and `--clean` remove exactly the rows this
 * script created and never touch real conversations.
 *
 * The generated analytics rows are derived from the generated messages, so the
 * Analytics tab's totals, charts and tables all agree with each other.
 */

// The config module requires these to be present; provide harmless defaults so the
// seeder runs without a fully configured .env. dotenv does not override values that
// already exist in process.env, and none of these affect seeding.
process.env.NODE_ENV = process.env.NODE_ENV || "development"
process.env.PORT = process.env.PORT || "3000"
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "info"

/** Digits as they appear inside a JID (no leading +). */
const DEMO_PHONE_PREFIX = "999000"
/**
 * How the app stores a sender: `cleanPhoneNumber()` prefixes bare digits with
 * "+", so demo rows must use the same shape or they will not match lookups.
 */
const DEMO_SENDER_PREFIX = `+${DEMO_PHONE_PREFIX}`
const DEMO_GROUP_IDS = ["demo-team@g.us", "demo-friends@g.us", "demo-family@g.us"]

/** Matches only rows created by this script. */
const IS_DEMO_SQL = `(chatId LIKE 'demo-%' OR chatId LIKE '${DEMO_PHONE_PREFIX}%')`
const IS_DEMO_PHONE_SQL = `(phoneNumber LIKE '${DEMO_SENDER_PREFIX}%' OR phoneNumber LIKE '${DEMO_PHONE_PREFIX}%')`

interface Person {
  /** Stored sender / users.phoneNumber value, e.g. "+999000101". */
  phone: string
  /** JID-local digits, e.g. "999000101". */
  digits: string
  name: string
}

const PEOPLE: Person[] = [
  "101,Aylin Mammadova",
  "102,Rashad Aliyev",
  "103,Nigar Huseynova",
  "104,Elvin Guliyev",
  "105,Leyla Ismayilova",
  "106,Tural Bayramov",
  "107,Sabina Kerimli",
  "108,Orkhan Safarov",
].map((entry) => {
  const [suffix, name] = entry.split(",")
  return {
    phone: `${DEMO_SENDER_PREFIX}${suffix}`,
    digits: `${DEMO_PHONE_PREFIX}${suffix}`,
    name,
  }
})

interface Chat {
  chatId: string
  chatName: string
  isGroup: boolean
  members: Person[]
  /** Relative share of overall traffic. */
  weight: number
}

const CHATS: Chat[] = [
  {
    chatId: DEMO_GROUP_IDS[0],
    chatName: "Team Standup",
    isGroup: true,
    members: PEOPLE.slice(0, 5),
    weight: 4,
  },
  {
    chatId: DEMO_GROUP_IDS[1],
    chatName: "Weekend Plans",
    isGroup: true,
    members: PEOPLE.slice(2, 7),
    weight: 3,
  },
  {
    chatId: DEMO_GROUP_IDS[2],
    chatName: "Family",
    isGroup: true,
    members: PEOPLE.slice(5, 8),
    weight: 2,
  },
  {
    chatId: `${PEOPLE[0].digits}@s.whatsapp.net`,
    chatName: PEOPLE[0].name,
    isGroup: false,
    members: [PEOPLE[0]],
    weight: 2,
  },
  {
    chatId: `${PEOPLE[3].digits}@s.whatsapp.net`,
    chatName: PEOPLE[3].name,
    isGroup: false,
    members: [PEOPLE[3]],
    weight: 1,
  },
  {
    chatId: `${PEOPLE[6].digits}@s.whatsapp.net`,
    chatName: PEOPLE[6].name,
    isGroup: false,
    members: [PEOPLE[6]],
    weight: 1,
  },
]

const USER_LINES = [
  "@bot what's on the agenda today?",
  "morning everyone",
  "can someone review my PR?",
  "@bot summarise the last few messages",
  "running about 10 minutes late",
  "shall we move standup to 10?",
  "@bot what's the weather looking like this weekend?",
  "just pushed the fix",
  "does anyone have the link to the doc?",
  "@bot translate this to Azerbaijani please",
  "sounds good to me",
  "I'll take a look after lunch",
  "@bot remind me about the deploy",
  "thanks!",
  "who's joining dinner on Friday?",
  "the build is green again",
]

const BOT_LINES = [
  "Here's a quick summary of the recent discussion.",
  "The agenda today covers the release checklist and open bugs.",
  "I've noted that down for you.",
  "Sure — here's what I found.",
  "That looks like a configuration issue. Try checking the base URL.",
  "Happy to help!",
  "Based on the conversation, the plan is to ship on Thursday.",
]

/** Deterministic PRNG so repeated seeds produce a stable, reviewable dataset. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const rand = makeRandom(20260727)

function pick<T>(items: T[]): T {
  return items[Math.floor(rand() * items.length)]
}

/** Weighted hour-of-day curve: quiet overnight, peaks at midday and mid-evening. */
const HOUR_WEIGHTS = [
  1, 1, 1, 1, 1, 2, 4, 9, 16, 22, 26, 28, 30, 27, 24, 23, 25, 28, 32, 30, 24, 16, 8, 3,
]

function pickHour(): number {
  const total = HOUR_WEIGHTS.reduce((a, b) => a + b, 0)
  let target = rand() * total
  for (let hour = 0; hour < HOUR_WEIGHTS.length; hour++) {
    target -= HOUR_WEIGHTS[hour]
    if (target <= 0) return hour
  }
  return 12
}

function pickChat(): Chat {
  const total = CHATS.reduce((sum, c) => sum + c.weight, 0)
  let target = rand() * total
  for (const chat of CHATS) {
    target -= chat.weight
    if (target <= 0) return chat
  }
  return CHATS[0]
}

function parseArgs(argv: string[]): { days: number; reset: boolean; clean: boolean } {
  const daysIndex = argv.indexOf("--days")
  const parsedDays = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : NaN
  return {
    days: Number.isFinite(parsedDays) && parsedDays > 0 ? Math.min(parsedDays, 365) : 90,
    reset: argv.includes("--reset"),
    clean: argv.includes("--clean"),
  }
}

interface GeneratedMessage {
  chatId: string
  sender: string
  senderName: string
  text: string
  timestamp: number
}

async function main(): Promise<void> {
  const { days, reset, clean } = parseArgs(process.argv.slice(2))

  // Imported lazily so the env defaults above are in place first.
  const { prisma } = await import("@/lib/prisma")

  const demoChatFilter = {
    OR: [
      { chatId: { startsWith: "demo-" } },
      { chatId: { startsWith: DEMO_PHONE_PREFIX } },
    ],
  }
  const demoPhoneFilter = {
    OR: [
      { phoneNumber: { startsWith: DEMO_SENDER_PREFIX } },
      { phoneNumber: { startsWith: DEMO_PHONE_PREFIX } },
    ],
  }

  const removeDemoData = async () => {
    const [messages, conversations, users] = await prisma.$transaction([
      prisma.message.deleteMany({ where: demoChatFilter }),
      prisma.conversation.deleteMany({ where: demoChatFilter }),
      prisma.user.deleteMany({ where: demoPhoneFilter }),
    ])
    return { messages: messages.count, conversations: conversations.count, users: users.count }
  }

  if (reset || clean) {
    const removed = await removeDemoData()
    console.log(
      `Removed demo data: ${removed.messages} messages, ${removed.conversations} conversations, ${removed.users} users.`
    )
    // Analytics rows are aggregates and cannot be attributed to demo rows alone, so
    // they are rebuilt from scratch below rather than selectively deleted.
    if (clean) {
      console.log("Done (--clean). Analytics rows were left untouched.")
      return
    }
  }

  const dayMs = 24 * 60 * 60 * 1000
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const generated: GeneratedMessage[] = []

  for (let dayOffset = days - 1; dayOffset >= 0; dayOffset--) {
    const dayStart = startOfToday.getTime() - dayOffset * dayMs
    const weekday = new Date(dayStart).getDay()

    // Volume: a gentle upward trend, quieter weekends, plus noise.
    const progress = (days - dayOffset) / days
    const trend = 0.6 + 0.8 * progress
    const weekendFactor = weekday === 0 || weekday === 6 ? 0.55 : 1
    const noise = 0.75 + rand() * 0.5
    const messageCount = Math.max(3, Math.round(28 * trend * weekendFactor * noise))

    for (let i = 0; i < messageCount; i++) {
      const chat = pickChat()
      const person = pick(chat.members)
      const hour = pickHour()
      const timestamp =
        dayStart + hour * 60 * 60 * 1000 + Math.floor(rand() * 60 * 60 * 1000)

      // Don't generate messages in the future for today's partial day.
      if (timestamp > Date.now()) continue

      const text = pick(USER_LINES)
      generated.push({
        chatId: chat.chatId,
        sender: person.phone,
        senderName: person.name,
        text,
        timestamp,
      })

      // The bot replies when mentioned, and always in private chats.
      const mentioned = text.includes("@bot")
      if (mentioned || !chat.isGroup) {
        generated.push({
          chatId: chat.chatId,
          sender: "Bot",
          senderName: "Bot",
          text: pick(BOT_LINES),
          timestamp: timestamp + 2000 + Math.floor(rand() * 6000),
        })
      }
    }
  }

  generated.sort((a, b) => a.timestamp - b.timestamp)

  // Aggregates derived from the generated messages so every view agrees.
  const perDay = new Map<string, { messages: number; apiCalls: number; tokens: number }>()
  const perChat = new Map<string, { count: number; last: number }>()
  const perUser = new Map<string, { count: number; first: number; last: number }>()

  for (const row of generated) {
    const date = new Date(row.timestamp).toISOString().split("T")[0]
    const day = perDay.get(date) || { messages: 0, apiCalls: 0, tokens: 0 }
    day.messages++
    if (row.sender === "Bot") {
      // Each bot reply corresponds to one LLM call.
      day.apiCalls++
      day.tokens += 280 + Math.floor(rand() * 620)
    }
    perDay.set(date, day)

    const chat = perChat.get(row.chatId) || { count: 0, last: 0 }
    chat.count++
    chat.last = Math.max(chat.last, row.timestamp)
    perChat.set(row.chatId, chat)

    if (row.sender !== "Bot") {
      const user = perUser.get(row.sender) || {
        count: 0,
        first: row.timestamp,
        last: row.timestamp,
      }
      user.count++
      user.first = Math.min(user.first, row.timestamp)
      user.last = Math.max(user.last, row.timestamp)
      perUser.set(row.sender, user)
    }
  }

  // createMany is a single round trip; chunked so the parameter count stays sane.
  const CHUNK = 500
  for (let i = 0; i < generated.length; i += CHUNK) {
    await prisma.message.createMany({
      data: generated.slice(i, i + CHUNK).map((row) => ({
        chatId: row.chatId,
        sender: row.sender,
        senderName: row.senderName,
        text: row.text,
        messageType: "text",
        timestamp: BigInt(row.timestamp),
      })),
    })
  }

  for (const chat of CHATS) {
    const stats = perChat.get(chat.chatId)
    if (!stats) continue
    await prisma.conversation.upsert({
      where: { chatId: chat.chatId },
      create: {
        chatId: chat.chatId,
        chatName: chat.chatName,
        isGroup: chat.isGroup,
        messageCount: stats.count,
        lastMessageAt: BigInt(stats.last),
      },
      update: {
        chatName: chat.chatName,
        messageCount: stats.count,
        lastMessageAt: BigInt(stats.last),
      },
    })
  }

  for (const person of PEOPLE) {
    const stats = perUser.get(person.phone)
    if (!stats) continue
    await prisma.user.upsert({
      where: { phoneNumber: person.phone },
      create: {
        phoneNumber: person.phone,
        displayName: person.name,
        pushName: person.name,
        lastSeen: BigInt(stats.last),
        firstSeen: BigInt(stats.first),
        messageCount: stats.count,
      },
      update: {
        displayName: person.name,
        pushName: person.name,
        lastSeen: BigInt(stats.last),
        firstSeen: BigInt(stats.first),
        messageCount: stats.count,
      },
    })
  }

  const chatCount = perChat.size
  const userCount = perUser.size
  for (const [date, day] of perDay.entries()) {
    await prisma.analytics.upsert({
      where: { date },
      create: {
        date,
        totalMessages: day.messages,
        totalUsers: userCount,
        totalConversations: chatCount,
        apiCalls: day.apiCalls,
        tokensUsed: day.tokens,
      },
      update: {
        totalMessages: day.messages,
        totalUsers: userCount,
        totalConversations: chatCount,
        apiCalls: day.apiCalls,
        tokensUsed: day.tokens,
      },
    })
  }


  const botMessages = generated.filter((m) => m.sender === "Bot").length
  console.log("Seeded demo data:")
  console.log(`  ${generated.length} messages (${botMessages} bot replies) over ${days} days`)
  console.log(`  ${perChat.size} conversations, ${perUser.size} users, ${perDay.size} analytics days`)
  console.log("\nOpen the admin panel → Analytics tab to view it.")
  console.log("Remove it again with: npm run seed -- --clean")
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error("Seeding failed:", err)
  process.exit(1)
})
