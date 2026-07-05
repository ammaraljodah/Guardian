// Curated category -> domain lists for theme-based blocking.
// These are base domains; matching also covers all subdomains
// (e.g. "youtube.com" also blocks "m.youtube.com", "music.youtube.com").

export const CATEGORIES = {
  social: {
    label: "Social Media",
    domains: [
      "facebook.com",
      "instagram.com",
      "twitter.com",
      "x.com",
      "tiktok.com",
      "snapchat.com",
      "reddit.com",
      "tumblr.com",
      "pinterest.com",
      "linkedin.com",
      "vk.com",
      "weibo.com",
      "threads.net",
      "mastodon.social",
      "bereal.com",
      "discord.com",
      "discord.gg",
      "discordapp.com"
    ]
  },
  games: {
    label: "Games",
    domains: [
      "roblox.com",
      "minecraft.net",
      "epicgames.com",
      "fortnite.com",
      "steampowered.com",
      "store.steampowered.com",
      "miniclip.com",
      "poki.com",
      "coolmathgames.com",
      "crazygames.com",
      "y8.com",
      "kongregate.com",
      "addictinggames.com",
      "friv.com",
      "agar.io",
      "slither.io",
      "chess.com",
      "ea.com",
      "battle.net",
      "xbox.com",
      "playstation.com",
      "nintendo.com",
      "itch.io"
    ]
  },
  video: {
    label: "Video / Streaming",
    domains: [
      "youtube.com",
      "netflix.com",
      "hulu.com",
      "twitch.tv",
      "disneyplus.com",
      "primevideo.com",
      "dailymotion.com",
      "vimeo.com",
      "hbomax.com",
      "max.com"
    ]
  },
  adult: {
    label: "Adult / NSFW",
    domains: [
      "pornhub.com",
      "xvideos.com",
      "xnxx.com",
      "xhamster.com",
      "redtube.com",
      "youporn.com",
      "onlyfans.com",
      "chaturbate.com",
      "brazzers.com",
      "adultfriendfinder.com"
    ]
  },
  gambling: {
    label: "Gambling",
    domains: [
      "bet365.com",
      "pokerstars.com",
      "888casino.com",
      "draftkings.com",
      "fanduel.com",
      "williamhill.com",
      "betway.com",
      "stake.com",
      "casino.com"
    ]
  },
  proxies: {
    label: "Proxies / Anonymizers (bypass tools)",
    domains: [
      "hidemyass.com",
      "hide.me",
      "proxysite.com",
      "kproxy.com",
      "croxyproxy.com",
      "croxyproxy.rocks",
      "hidester.com",
      "4everproxy.com",
      "whateverorigin.org",
      "proxyium.com",
      "blockaway.net",
      "1ft.io",
      "nordvpn.com",
      "expressvpn.com",
      "surfshark.com",
      "protonvpn.com",
      "tunnelbear.com",
      "psiphon.ca",
      "ultrasurf.us",
      "vpnbook.com",
      "browsec.com",
      "zenmate.com",
      "hola.org",
      "webproxy.to",
      "unblocksites.co",
      "genmirror.com",
      "steganos.com"
    ]
  }
};

// Content-based detection: how to recognize a category from PAGE CONTENT
// (title, meta tags, visible text) when the domain isn't on the fixed list.
// `threshold` = how many distinct keyword hits are required to block, so a
// single incidental word won't trigger a false positive.
export const DETECTION = {
  adult: {
    threshold: 2,
    keywords: [
      "porn",
      "xxx",
      "nsfw",
      "hardcore",
      "hentai",
      "camgirl",
      "sex cam",
      "adult video",
      "explicit content",
      "18+ only",
      "nude",
      "milf",
      "escort"
    ]
  },
  gambling: {
    threshold: 2,
    keywords: [
      "casino",
      "poker",
      "roulette",
      "blackjack",
      "sportsbook",
      "betting odds",
      "place a bet",
      "slots",
      "jackpot",
      "wager",
      "free spins",
      "bet now",
      "live betting"
    ]
  },
  games: {
    threshold: 2,
    keywords: [
      "play free games",
      "free online games",
      "multiplayer game",
      "play now",
      "html5 game",
      "gameplay",
      "games to play",
      "top games",
      "game controls",
      "unblocked games"
    ]
  },
  social: {
    threshold: 3,
    keywords: [
      "news feed",
      "friend request",
      "followers",
      "direct message",
      "share your story",
      "create a post",
      "people you may know",
      "log in to connect",
      "add friend",
      "your timeline"
    ]
  },
  video: {
    threshold: 2,
    keywords: [
      "watch free",
      "stream now",
      "full episodes",
      "watch online",
      "episodes and clips",
      "live stream",
      "subscribe to watch",
      "watch movies"
    ]
  },
  proxies: {
    threshold: 2,
    keywords: [
      "free web proxy",
      "unblock websites",
      "unblock any website",
      "anonymous browsing",
      "cors anywhere",
      "web proxy server",
      "bypass filter",
      "bypass school",
      "hide your ip",
      "surf anonymously",
      "enter url to unblock"
    ]
  }
};
