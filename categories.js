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
      "bereal.com"
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

// Keyword fragments used by the content script for heuristic detection of
// web-based proxy / "unblocker" pages that aren't in the domain list.
export const PROXY_KEYWORDS = [
  "free web proxy",
  "unblock websites",
  "anonymous browsing",
  "cors anywhere",
  "web proxy server",
  "bypass filter",
  "hide your ip"
];
