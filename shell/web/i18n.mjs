/*
 * The words the interface shows, in the languages it can show them in.
 *
 * This module is deliberately small and dependency-free: it is loaded by the
 * browser, by the Node-side tests, and by nothing that needs `node:`; the only
 * state it keeps is the current locale.  Two rules make it usable in a UI that
 * re-renders whole cards:
 *
 *   1. `t(key, vars)` reads the *current* locale, so a card built after
 *      `setLocale()` is already right; switching the language re-renders the
 *      board and every card asks again.
 *   2. A missing translation never renders as a missing string: the English
 *      text answers, and if even that is absent the key itself is shown, so a
 *      half-finished translation looks like English, not like breakage.
 *
 * The catalogue covers the words the interface itself owns -- card kinds,
 * buttons, section headings, short labels.  Log lines, diagnostics and anything
 * that names a file stay in the language the shell writes them in, because they
 * are also read by the command line and by tests.
 */

/** The locales the catalogue is complete enough for. */
export const SUPPORTED_LOCALES = Object.freeze(["en", "zh"]);

/** What a fresh install shows before anyone picks a language. */
export const DEFAULT_LOCALE = "en";

/** How a locale names itself in the language picker. */
export const LOCALE_LABELS = Object.freeze({ en: "English", zh: "中文" });

const MESSAGES = Object.freeze({
  en: Object.freeze({
    "common.yes": "yes",
    "common.no": "no",
    "common.none": "(none)",
    "common.empty": "(empty)",
    "common.cancel": "cancel",
    "common.close": "close",
    "common.save": "save",
    "common.reload": "reload",

    "kind.editor": "Editor",
    "kind.runner": "Runner",
    "kind.note": "Note",
    "kind.files": "Files",
    "kind.project": "Project",
    "kind.sheet": "Sheet",
    "kind.story": "Story",
    "kind.pixel": "Pixel",
    "kind.rig": "Rig",
    "kind.mod": "Mod",
    "kind.problems": "Problems",
    "kind.docs": "Docs",
    "kind.settings": "Settings",
    "kind.help": "Help",
    "kind.audio": "Audio",
    "kind.agent": "Agent",
    "card.resize": "drag to resize",
    "kind.start": "Start here",

    "mod.open": "open",
    "mod.validate": "validate",
    "mod.new": "new",
    "mod.import": "import",
    "mod.export": "export zip",
    "mod.install": "install into game",
    "mod.log": "what the game said",
    "mod.section.open": "Open a package",
    "mod.section.check": "Check it",
    "mod.section.create": "Create a file",
    "mod.section.import": "Bring a file in",
    "mod.section.export": "Hand the package on",
    "mod.section.install": "Into the game",
    "mod.section.log": "What the game said",
    "mod.placeholder.dir": "NewMod",
    "mod.placeholder.newName": "Goods_Sword",
    "mod.placeholder.importFrom": "<art>/icon.png",
    "mod.placeholder.importTo": "Sprites/icon.png (optional)",
    "mod.placeholder.exportOut": "(optional) FolderName.zip",
    "mod.placeholder.installDir": "(optional) the game's Mods folder",
    "mod.placeholder.logName": "(optional) ModName",
    "mod.pick": "pick a package the game already has",
    "mod.recent": "recently opened",
    "mod.refresh": "refresh list",
    "mod.dropped": "opened from the command line",
    "mod.empty": "(empty)",
    "mod.initial": "NewMod (relative to the mods root) or an absolute path, then open",
    "mod.pathNote": "relative paths resolve against the mods root; an absolute path also works",
    "mod.pickNone": "no packages in the game's Mods folder yet -- type a path below",
    "mod.pickFound": "listed {count} package(s)",

    "problems.run": "validate",
    "problems.placeholder": "Mods/MyMod",
    "problems.initial": "validate a mod directory, e.g. Mods/MyMod",
    "problems.giveDir": "give a mod directory first",
    "problems.validating": "validating...",
    "problems.nothing": "nothing to report",
    "problems.clear": "clear",
    "problems.empty": "nothing to show yet -- validate a package from its card",
    "problems.errors": "errors",
    "problems.warnings": "warnings",
    "problems.infos": "infos",
    "problems.howtofix": "how to fix",

    "help.sources": "where the answers come from",
    "help.matrix": "what the game supports",
    "help.commands": "commands",
    "help.wiki": "the game's wiki",
    "help.codes": "every diagnostic code is documented in docs/MODS.md in the source tree",

    "settings.language": "language",
    "settings.languageNote": "the interface only; files and diagnostics keep their names",
    "settings.where": "where this lives",
    "settings.gameMods": "game mods",
    "settings.knowledge": "knowledge base",
    "settings.ai": "AI provider",
    "settings.machine": "this machine",
    "settings.endpoint": "endpoint",
    "settings.model": "model",
    "settings.apiKey": "api key",
    "settings.apiKeyNote": "the stored key is never shown; leave it blank to keep it",
    "settings.apiKeyStored": "stored key is kept; type to replace it",
    "settings.apiKeyNone": "no key stored yet",
    "settings.temperature": "temperature",
    "settings.maxTokens": "max tokens",
    "settings.timeout": "timeout (ms)",
    "settings.stream": "stream the answer",
    "settings.forgetKey": "forget the stored key",
    "settings.opensIn": "opens in",
    "settings.opensInNote": "the view a new window starts in",
    "settings.poll": "poll interval (ms)",
    "settings.pollNote": "how often the cards ask the kernel what changed",
    "settings.userData": "user data",
    "settings.preferences": "preferences",
    "settings.aiFile": "ai provider",
    "settings.windowSettings": "window settings",
    "settings.workspace": "workspace",
    "settings.mods": "mods",
    "settings.languageAuto": "follow the system",
    "settings.guide": "open the start guide",
    "settings.reading": "reading settings…",
    "settings.saving": "writing…",
    "settings.saved": "saved in the user data directory; a window reads it on boot",
    "settings.savedNow": "saved; this window keeps its view until it is reloaded",
    "settings.save": "save",
    "settings.reload": "reload",

    "start.title": "Start here",
    "start.intro": "Three steps, in the order they unblock each other.",
    "start.step1": "Open the folder the game reads mods from",
    "start.step1.body": "The editor finds it on its own in most installs; if it cannot, pick it by hand.",
    "start.step2": "Pick a package and validate it",
    "start.step2.body": "Validation lists every problem with the file and line it came from.",
    "start.step3": "Fix, look, then install",
    "start.step3.body": "Open a problem to jump to it. When it is clean, install it into the game and read the log.",
    "start.openMods": "open the game's Mods folder",
    "start.openPackage": "open a package",
    "start.help": "open the help card",
    "start.finish": "got it, hide this",
    "start.done": "the guide is hidden; the help card keeps the same answers",
    "start.step": "step {n}",

    "audio.loading": "reading the bytes...",
    "audio.missing": "no recording is opened",
    "audio.size": "{size}, {length}",

    "agent.ask": "ask",
    "agent.stop": "stop",
    "agent.empty": "ask about this package -- the cards' own tools are offered to the model, read-only",
    "agent.unconfigured": "no provider is configured; open Settings and fill in the endpoint and key first",
    "hint.D001": "the file name and the techName have to match -- rename one of them",
    "hint.D002": "the value does not follow the schema -- compare it with a file the game ships",
    "hint.D004": "a required field is missing -- the schema lists it",
    "hint.D005": "a nullable object still needs its two keys when it is present",
    "hint.D006": "the define names a sprite the package does not contain -- import or draw it",
    "hint.D007": "the PNG is damaged -- re-export the image",
    "hint.D008": "the WAV header does not parse -- re-export the recording as 16-bit PCM",
    "hint.D009": "a spine skeleton needs its atlas and page image beside it, from the same export",
    "hint.D010": "the table does not follow the game's eight-column CSV contract",
    "hint.D011": "spineAssetPath names a file that is not in the package",
    "hint.D012": "a value breaks a schema constraint -- the message names the keyword",
    "hint.D013": "a $ref names a title nothing in the package defines",
    "hint.D014": "this line id is in a Yarn file but not in a localisation table",
    "hint.D015": "this table row's line id is not in the package's Yarn",
    "hint.D016": "the same line id appears twice -- one row owns it",
    "hint.D017": "line ids are `line:` plus 7 hex digits -- these will not resolve",
    "hint.D018": "an addressable address points at a package path, not an asset address",
    "hint.D019": "a hand-written reference has no Guid -- copy the whole object from a game export",
    "hint.D020": "GetTopic()/WasVisited() take a node title -- the title must exist",
    "hint.D021": "a new canvas is 256x144 with initialTransform -7.2; other sizes scale the UI",
    "hint.D022": "a Guid must be the 32-hex shape the game writes",
    "hint.D023": "a lock hashes the base table's own row text -- edit the base table and let the card recompute it",
    "hint.D101": "the knowledge base does not know this type -- check the spelling or the schema set",
    "hint.D102": "the game's schema has no such field -- a typo, or a newer schema",
    "hint.D103": "two defines in this package write the same techName -- only one wins",
    "hint.M001": "mod.json is missing or not valid JSON",
    "hint.M006": "mod.json has no name",
    "hint.M008": "the manifest's name or path conventions do not match the game's loader",
    "hint.M009": "the manifest version is not the x.y.z shape the game reads",
    "hint.M012": "the techName style the manifest declares is not one the wiki documents",
    "hint.M013": "the support matrix marks this type unsupported -- the game will ignore the file",
    "hint.M014": "the support matrix marks this type partly supported -- check which fields the game reads",
    "hint.OPEN001": "the path is not a directory the shell can list",
    "hint.Y103": "a Yarn node is missing its title line",
    "hint.Y107": "a jump names a node that is not in the file",
    "hint.Y110": "two nodes share a title -- the second one is unreachable",
    "hint.Y122": "a line uses a tag the game does not know",
    "hint.Y123": "this deprecated verb has a supported replacement",
  }),
  zh: Object.freeze({
    "common.yes": "是",
    "common.no": "否",
    "common.none": "（无）",
    "common.empty": "（空）",
    "common.cancel": "取消",
    "common.close": "关闭",
    "common.save": "保存",
    "common.reload": "重载",

    "kind.editor": "编辑器",
    "kind.runner": "运行器",
    "kind.note": "笔记",
    "kind.files": "文件",
    "kind.project": "项目",
    "kind.sheet": "表格",
    "kind.story": "剧情",
    "kind.pixel": "像素画",
    "kind.rig": "立绘",
    "kind.mod": "模组",
    "kind.problems": "问题",
    "kind.docs": "文档",
    "kind.settings": "设置",
    "kind.help": "帮助",
    "kind.audio": "音频",
    "kind.agent": "助手",
    "card.resize": "拖动改变大小",
    "kind.start": "开始使用",

    "mod.open": "打开",
    "mod.validate": "校验",
    "mod.new": "新建",
    "mod.import": "导入",
    "mod.export": "导出 zip",
    "mod.install": "装进游戏",
    "mod.log": "游戏说了什么",
    "mod.section.open": "打开一个模组包",
    "mod.section.check": "校验它",
    "mod.section.create": "新建文件",
    "mod.section.import": "导入文件",
    "mod.section.export": "把模组包交出去",
    "mod.section.install": "装进游戏",
    "mod.section.log": "游戏日志",
    "mod.placeholder.dir": "NewMod",
    "mod.placeholder.newName": "Goods_Sword",
    "mod.placeholder.importFrom": "<素材>/icon.png",
    "mod.placeholder.importTo": "Sprites/icon.png（可选）",
    "mod.placeholder.exportOut": "（可选）FolderName.zip",
    "mod.placeholder.installDir": "（可选）游戏的 Mods 目录",
    "mod.placeholder.logName": "（可选）ModName",
    "mod.pick": "从游戏已有的模组里选一个",
    "mod.recent": "最近打开",
    "mod.refresh": "刷新列表",
    "mod.dropped": "从命令行打开的",
    "mod.empty": "（空）",
    "mod.initial": "NewMod（相对 mods 根）或绝对路径，然后点打开",
    "mod.pathNote": "相对路径按 mods 根解析；也可用绝对路径",
    "mod.pickNone": "游戏的 Mods 文件夹里还没有模组 —— 在下面输入路径",
    "mod.pickFound": "列出 {count} 个模组",

    "problems.run": "校验",
    "problems.placeholder": "Mods/MyMod",
    "problems.initial": "先校验一个模组目录，例如 Mods/MyMod",
    "problems.giveDir": "先给一个模组目录",
    "problems.validating": "正在校验…",
    "problems.nothing": "没有发现问题",
    "problems.clear": "清空",
    "problems.empty": "还没有内容 —— 先在模组卡上点“校验”",
    "problems.errors": "错误",
    "problems.warnings": "警告",
    "problems.infos": "提示",
    "problems.howtofix": "怎么修",

    "help.sources": "答案从哪里来",
    "help.matrix": "游戏支持什么",
    "help.commands": "命令",
    "help.wiki": "游戏的 wiki",
    "help.codes": "每一个诊断码都写在源码的 docs/MODS.md 里",

    "settings.language": "界面语言",
    "settings.languageNote": "只影响界面；文件名和诊断码保持原样",
    "settings.where": "这些东西在哪",
    "settings.gameMods": "游戏模组目录",
    "settings.knowledge": "知识库",
    "settings.ai": "AI 提供方",
    "settings.machine": "这台机器",
    "settings.endpoint": "接口地址",
    "settings.model": "模型",
    "settings.apiKey": "密钥",
    "settings.apiKeyNote": "已保存的密钥不会显示；留空表示保留",
    "settings.apiKeyStored": "已保存密钥；输入即替换",
    "settings.apiKeyNone": "还没有密钥",
    "settings.temperature": "温度",
    "settings.maxTokens": "最大 token",
    "settings.timeout": "超时（毫秒）",
    "settings.stream": "流式显示回答",
    "settings.forgetKey": "忘记已保存的密钥",
    "settings.opensIn": "默认视图",
    "settings.opensInNote": "新窗口启动时使用的视图",
    "settings.poll": "轮询间隔（毫秒）",
    "settings.pollNote": "卡片多久向内核询问一次变化",
    "settings.userData": "用户数据",
    "settings.preferences": "偏好",
    "settings.aiFile": "AI 提供方",
    "settings.windowSettings": "窗口设置",
    "settings.workspace": "工作区",
    "settings.mods": "Mods",
    "settings.languageAuto": "跟随系统",
    "settings.guide": "打开新手引导",
    "settings.reading": "正在读取设置…",
    "settings.saving": "正在写入…",
    "settings.saved": "已保存到用户数据目录；窗口在启动时读取",
    "settings.savedNow": "已保存；本窗口保持当前视图，直到重新加载",
    "settings.save": "保存",
    "settings.reload": "重新读取",

    "start.title": "开始使用",
    "start.intro": "三步，顺序就是解开下一步的顺序。",
    "start.step1": "打开游戏读取模组的目录",
    "start.step1.body": "大多数安装下编辑器能自己找到；找不到就手动选一下。",
    "start.step2": "选一个模组包并校验",
    "start.step2.body": "校验会列出每个问题和它所在的文件、行号。",
    "start.step3": "修、看、然后装进游戏",
    "start.step3.body": "点一条问题就跳到位置。校验干净后装进游戏，再读游戏日志。",
    "start.openMods": "打开游戏的 Mods 目录",
    "start.openPackage": "打开一个模组包",
    "start.help": "打开帮助卡",
    "start.finish": "知道了，隐藏引导",
    "start.done": "引导已隐藏；帮助卡里有同样的答案",
    "start.step": "第 {n} 步",

    "audio.loading": "正在读取字节…",
    "audio.missing": "还没有打开录音",
    "audio.size": "{size}，时长 {length}",

    "agent.ask": "发送",
    "agent.stop": "停止",
    "agent.empty": "问问这个模组包 —— 卡片自己的工具会以只读方式提供给模型",
    "agent.unconfigured": "还没配置服务商；先打开“设置”填好地址和密钥",
    "hint.D001": "文件名和 techName 必须一致 —— 改掉其中一个",
    "hint.D002": "值不符合 schema —— 对照游戏自带的同类文件",
    "hint.D004": "缺了必填字段 —— schema 里列出了它",
    "hint.D005": "可空对象一旦存在，两个键都要有",
    "hint.D006": "定义里的精灵不在包里 —— 导入它或画一张",
    "hint.D007": "PNG 损坏 —— 重新导出图像",
    "hint.D008": "WAV 头读不出 —— 重新导出为 16-bit PCM",
    "hint.D009": "脊骨需要同一次导出的 atlas 和页面图并排放在一起",
    "hint.D010": "表不符合游戏的八列 CSV 契约",
    "hint.D011": "spineAssetPath 指向的文件不在包里",
    "hint.D012": "值违反了 schema 约束 —— 消息里写了哪个关键字",
    "hint.D013": "$ref 指向的 title 在包里没有定义",
    "hint.D014": "这个行 id 在 Yarn 里有，但本地化表里没有",
    "hint.D015": "这一行的 id 不在包的 Yarn 里",
    "hint.D016": "同一个行 id 出现两次 —— 只能有一行拥有它",
    "hint.D017": "行 id 是 `line:` 加 7 位十六进制 —— 这些不会被解析",
    "hint.D018": "addressable 地址指向的是包内路径，不是资源地址",
    "hint.D019": "手写的引用缺 Guid —— 从游戏导出里整个拷过来",
    "hint.D020": "GetTopic()/WasVisited() 要的是节点标题 —— 标题必须存在",
    "hint.D021": "新画布是 256x144、initialTransform -7.2；别的尺寸会把 UI 缩放弄乱",
    "hint.D022": "Guid 必须是游戏写的 32 位十六进制形状",
    "hint.D023": "lock 是基表那一行文字的哈希 —— 改基表，卡会重算",
    "hint.D101": "知识库不认识这个类型 —— 检查拼写或 schema 集",
    "hint.D102": "游戏的 schema 没有这个字段 —— 拼错了，或者 schema 更新了",
    "hint.D103": "包里两个定义写了同一个 techName —— 只有一个生效",
    "hint.M001": "mod.json 缺失或不是合法 JSON",
    "hint.M006": "mod.json 没有 name",
    "hint.M008": "manifest 的命名或路径不符合游戏加载器",
    "hint.M009": "manifest 版本不是游戏读的 x.y.z 形式",
    "hint.M012": "manifest 声明的 techName 风格在 wiki 里没有",
    "hint.M013": "支持矩阵标为不支持 —— 游戏会忽略这个文件",
    "hint.M014": "支持矩阵标为部分支持 —— 看看游戏读哪些字段",
    "hint.OPEN001": "这个路径不是一个能列出来的目录",
    "hint.Y103": "某个 Yarn 节点缺了 title 行",
    "hint.Y107": "跳转指向的节点不在文件里",
    "hint.Y110": "两个节点同名 —— 后一个达不到",
    "hint.Y122": "台词用了游戏不认识的 tag",
    "hint.Y123": "这个废弃动词有可用的替代",
  })
});

/** messageKeys() is what the tests compare the two catalogues with. */
export function messageKeys(locale = "en") {
  const table = MESSAGES[locale] || MESSAGES.en;
  return Object.keys(table);
}

/**
 * Turn a BCP-47-ish tag into one of SUPPORTED_LOCALES, falling back to English.
 * `zh-CN`, `zh_TW`, `ZH` all mean `zh`; anything unrecognised means `en`.
 */
export function normalizeLocale(tag) {
  if (typeof tag !== "string") {
    return DEFAULT_LOCALE;
  }
  const lower = tag.trim().toLowerCase();
  if (lower === "") {
    return DEFAULT_LOCALE;
  }
  const base = lower.split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(base) ? base : DEFAULT_LOCALE;
}

/** The label for a locale in its own language, for the settings picker. */
export function localeLabel(locale) {
  const normal = normalizeLocale(locale);
  return LOCALE_LABELS[normal] || normal;
}

/** True when the catalogue has this key in this locale (English counts as base). */
export function hasMessage(locale, key) {
  const normal = normalizeLocale(locale);
  if (normal !== "en" && MESSAGES[normal] && MESSAGES[normal][key] !== undefined) {
    return true;
  }
  return MESSAGES.en[key] !== undefined;
}

/**
 * Look a key up, fill `{name}` placeholders, and fall back en -> key.
 * A null/undefined variable is rendered as an empty string rather than "null".
 */
export function translate(locale, key, vars) {
  const normal = normalizeLocale(locale);
  let text = MESSAGES[normal] ? MESSAGES[normal][key] : undefined;
  if (text === undefined) {
    text = MESSAGES.en[key];
  }
  if (text === undefined) {
    return String(key);
  }
  if (vars === null || typeof vars !== "object") {
    return text;
  }
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name) => {
    const value = vars[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

/* ------------------------------------------------------------------ */
/* the current locale                                                  */
/* ------------------------------------------------------------------ */

let current = DEFAULT_LOCALE;

/** The locale new cards render in. */
export function getLocale() {
  return current;
}

/**
 * Set the locale used by `t()` from now on.  Returns the locale that was
 * actually set (a tag for a language this build does not have becomes `en`),
 * so a caller can persist the normalized value instead of the raw one.
 */
export function setLocale(locale) {
  current = normalizeLocale(locale);
  return current;
}

/** `t(key, vars)` in the current locale; the short form cards use. */
export function t(key, vars) {
  return translate(current, key, vars);
}

/** A card kind's human name in the current locale, or the kind itself. */
export function kindLabel(kind) {
  const name = String(kind);
  const key = "kind." + name;
  if (hasMessage(current, key)) {
    return t(key);
  }
  if (hasMessage("en", key)) {
    return translate("en", key);
  }
  return name;
}
