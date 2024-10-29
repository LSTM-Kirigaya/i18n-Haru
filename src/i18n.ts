// 参考 ISO 639语言编码 https://kirigaya.cn/blog/article?seq=68

export interface ISOItem {
    code: string,
    name: string
}

export const ISOCodeArray: ISOItem[] = [
    { code: "af",       name: "Afrikaans" },
    { code: "ar",       name: "العربية" },
    { code: "bg",       name: "Български" },
    { code: "bn",       name: "বাংলা" },
    { code: "ca",       name: "Català" },
    { code: "cs",       name: "Čeština" },
    { code: "da",       name: "Dansk" },
    { code: "de",       name: "Deutsch" },
    { code: "el",       name: "Ελληνικά" },
    { code: "en",       name: "English" },
    { code: "es",       name: "Español" },
    { code: "et",       name: "Eesti" },
    { code: "fa",       name: "فارسی" },
    { code: "fi",       name: "Suomi" },
    { code: "fr",       name: "Français" },
    { code: "gu",       name: "ગુજરાતી" },
    { code: "he",       name: "עברית" },
    { code: "hi",       name: "हिन्दी" },
    { code: "hr",       name: "Hrvatski" },
    { code: "hu",       name: "Magyar" },
    { code: "id",       name: "Bahasa Indonesia" },
    { code: "it",       name: "Italiano" },
    { code: "ja",       name: "日本語" },
    { code: "kn",       name: "ಕನ್ನಡ" },
    { code: "ko",       name: "한국어" },
    { code: "lt",       name: "Lietuvių" },
    { code: "lv",       name: "Latviešu" },
    { code: "mk",       name: "Македонски" },
    { code: "ml",       name: "മലയാളം" },
    { code: "mr",       name: "मराठी" },
    { code: "ms",       name: "Bahasa Melayu" },
    { code: "nl",       name: "Nederlands" },
    { code: "no",       name: "Norsk" },
    { code: "pa",       name: "ਪੰਜਾਬੀ" },
    { code: "pl",       name: "Polski" },
    { code: "pt",       name: "Português" },
    { code: "ro",       name: "Română" },
    { code: "ru",       name: "Русский" },
    { code: "sk",       name: "Slovenčina" },
    { code: "sl",       name: "Slovenščina" },
    { code: "so",       name: "Soomaali" },
    { code: "sq",       name: "Shqip" },
    { code: "sr",       name: "Српски" },
    { code: "sv",       name: "Svenska" },
    { code: "sw",       name: "Kiswahili" },
    { code: "ta",       name: "தமிழ்" },
    { code: "te",       name: "తెలుగు" },
    { code: "th",       name: "ไทย" },
    { code: "tr",       name: "Türkçe" },
    { code: "uk",       name: "Українська" },
    { code: "ur",       name: "اردو" },
    { code: "vi",       name: "Tiếng Việt" },
    { code: "zh-cn",    name: "中文" },
    { code: "zh-hans",  name: "中文" },
    { code: "zh-tw",    name: "繁体中文" },
    { code: "zh-hk",    name: "繁體中文" },
    { code: "zh-sg",    name: "繁體中文" },
    { code: "zh-hant",  name: "繁體中文" }
];