import type { Catalogue } from "../types";
import type { settings as enSettings } from "../en/settings";
// Settings (plan D7): language, compression speed (0.9.11), and the opt-in crash log. Nothing is ever sent anywhere.
export const settings = {
  "settings.languageHeading": "语言",
  "settings.languageLabel": "界面语言",
  "settings.languageNote": "立即生效，并记在这台电脑上。压缩文件中的文件名和文件夹名不会被翻译。",
  "settings.speedHeading": "速度",
  "settings.speedAllCores": "使用全部处理器核心（{n} 个）压缩：大文件和文件夹更快",
  "settings.speedNote": "关闭：只用一个核心，长时间任务时电脑响应更流畅。两种方式生成的压缩文件完全相同。从下一个任务开始生效。",
  "settings.speedLoadFailed": "无法读取速度设置",
  "settings.speedSaveFailed": "无法更改速度设置",
  "settings.heading": "设置",
  "settings.crashHeading": "崩溃报告",
  "settings.crashPolicy":
    "MOCHI 从不发送崩溃报告：没有崩溃报告服务器，本应用也不会为此发出任何网络请求。如果您打开日志，每次崩溃的记录会保存在这台电脑上的一个文件中，您可以在这里查看、保存或删除。",
  "settings.crashCollected":
    "每条记录包含时间、应用版本、平台、出错线程的名称、程序出错的位置以及一组函数名。记录中绝不包含口令或压缩文件的内容；除非您同时打开下面的出错消息选项，否则也不包含文件名或文件夹名。",
  "settings.crashLimits":
    "只记录程序内部的崩溃。系统网页视图出错，或应用被系统结束，不会留下记录。日志只保留最近的记录。",
  "settings.enable": "保留本地崩溃日志（默认关闭，需手动打开）",
  "settings.details": "在每条记录中包含出错消息",
  "settings.detailsWarning":
    "出错消息是程序对故障原因的自我描述，可能引用您正在处理的文件名或文件夹名。本应用不会把口令或压缩文件内容写入其中，但分享之前请先阅读这段文字。",
  "settings.state": "日志中有 {entries}，占用磁盘 {size}。",
  "settings.entryOne": "{n} 条记录",
  "settings.entryMany": "{n} 条记录",
  "settings.show": "显示日志",
  "settings.hide": "隐藏日志",
  "settings.export": "保存日志副本…",
  "settings.clear": "删除日志",
  "settings.logLabel": "崩溃日志文本",
  "settings.logEmpty": "日志为空。",
  "settings.logTruncated": "此处不显示较早的记录；保存的副本中包含它们。",
  "settings.exported": "已将崩溃日志的副本保存到 {name}。",
  "settings.cleared": "崩溃日志已删除。",
  "settings.enabledNow": "本地崩溃日志已打开。",
  "settings.disabledNow": "本地崩溃日志已关闭。",
  "settings.loadFailed": "无法读取崩溃报告设置",
  "settings.saveFailed": "无法更改崩溃报告设置",
  "settings.readFailed": "无法读取崩溃日志",
  "settings.exportFailed": "无法保存崩溃日志",
  "settings.clearFailed": "无法删除崩溃日志",
} satisfies Catalogue<typeof enSettings>;
