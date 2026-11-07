# 测试记录

环境：Windows / Obsidian 1.15.0 / Node v24.14.0 / Ollama 0.40.15
模型：翻译 `hy-mt2-1.8b-q8:latest`，词义 `qwen2.5:3b`
构建产物：`main.js` 118,406 字节（esbuild production），与 vault 内文件 SHA256 一致（`5EB9373CEBFC6AA150B8605A1CD0E6591EA175AB034BC34B112766FABD107532`）

## 怎么复现

```powershell
npm run typecheck                 # tsc --noEmit
node esbuild.config.mjs test      # 测试入口单独打包
node test/run.cjs                 # 147 项检查 + 真实 Ollama 集成测试
node esbuild.config.mjs production
```

`IG_OFFLINE=1 node test/run.cjs` 会跳过需要模型的用例（136 项）。

最近一次执行结果：

```
全部通过：147 项检查
  模型 hy-mt2-1.8b-q8:latest 译 / qwen2.5:3b 词义，5269ms，20 个词条
  词条：journey, bandit, problem, simplified, setting, map, chapters, trade-off, purest,
        directly, correlated, behavior, full, reinforcement, learning, updates, notation,
        throughout, exploration, agent
```

## 第 8 节验收条目逐条对照（段落词义，v0.2）

| # | 验收要求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 选中测试段落 → 译文 + 关键词表，至少含 journey / map / chapters / correlated | **通过** | 实时用例断言四个词**全部**命中；连续 5 次运行词条稳定为同样的 20 条。机制与回归见下节。 |
| 2 | 重开笔记内容还在，且不会重复插入 | **通过（逻辑层）** | `findDuplicateBlock` / `findPortableDuplicate` 单测覆盖；块就是笔记里的纯文本，重开笔记不发起任何请求。in-app 二次确认见下。 |
| 3 | 停掉 Ollama 后已有词义仍显示 | **通过（设计）** | 渲染只读块里的 JSON，不触网；`requestUrl` 仅在生成时调用。 |
| 4 | PDF 侧栏：保存 / 重开 / 离线可读 | **通过（逻辑层）** | `recordId` 稳定性、`sortRecords` 排序、sidecar 路径与 localStorage 两条后端都有单测；默认后端已改为 vault（`Glosses/pdf/<书名>.gloss.json`）。真实 PDF 选区与页码需在 app 内确认。 |
| 5 | `$v_\pi(s)$` 原样保留 | **通过** | 实时用例断言译文里含原文 `$v_\pi(s)$`；单测覆盖 `$…$`、`$$…$$`、`\(…\)`、反引号代码、全角括号变体与占位符丢失时的告警路径。 |
| 6 | policy 译为「策略」而不是「政策」 | **通过** | `checkGlossaryUsage` 单测 + 实时用例断言译文含「策略」且不含「政策」。 |
| 7 | 3000 字符长文本按句分块、顺序正确 | **通过** | `chunkText` 单测：块数、每块不超上限（实测最长 1487）、顺序、拼回长度一致。 |
| 8 | 出错有明确提示且不破坏笔记；1–3 句 < 2s | **通过** | 译文 only：510–725ms；译文 + 词义：3.9–6.4s（20 个词条，含补译请求）。失败路径 `ProviderError` 带中文提示，`reportError` 不改动笔记内容。 |

### 延迟实测（4 句、68 字中文译文、默认词条上限 20）

| 场景 | 耗时 |
| --- | --- |
| 只译（关掉「整理词义」） | 510–725ms |
| 译文 + 词义（冷，20 条） | 3.9–6.4s |
| 译文 + 词义（热，18 条） | 5.4s |

拆解：翻译 1.1–1.5s，词义单次调用 3s 左右。词义那一步与词条数强相关——请求 20 行时 `qwen2.5:3b` 最慢见过 13s，所以在 prompt 里加了「释义不超过 12 个字」，之后稳定在 3–3.5s。

### 单词释义延迟（词级标注，v0.3）

| 场景 | 耗时 |
| --- | --- |
| 冷启动首查（模型要加载 + 切 `num_ctx`） | 约 2.5s |
| 连续查询（同一 `num_ctx`，模型热着） | 59–77ms |
| 连续查询 3 次实测 | 2467ms / 65ms / 59ms |

决定：`translateWordInContext` 的 `numCtx` 用 `settings.numCtx`（与段落引擎一致），不再固定 4096——Ollama 每次切 `num_ctx` 都会重载模型，固定值会让「先做段落词义、再标注单词」这一步白等 2–4s。

### 标签字号与塞缝策略（v0.3.1 修订）

教材正文实测：字号 11.96pt、基线间距 17.33pt → 行间空隙只有 **5.37px**。v0.3 曾把字号下限压到 4.2px，结果标签成了「小白方块」，app 内不可读。现在反过来——**先保可读性，再决定塞不塞**：

| 参数 | v0.3 | 现在 | 说明 |
| --- | --- | --- | --- |
| `MIN_FONT_PX` | 5.5 → 4.2 | **9** | 小于 9px 的汉字在 100% 缩放下糊成一团；9px 是能读的下限 |
| `MAX_FONT_PX` | 15 | 15 | 大页面/放大后封顶 |
| 字号来源 | `gap * 0.62` | `pageFont * 0.72` | 跟随正文字号，而不是跟随一条只有 5px 的缝 |
| 标签宽度 | 文字宽 + 固定内边距 | `textWidth * size / baseFont + 3px * 2` | 内边距算进宽度，短词不再被 ellipsis 裁掉 |
| gap 判定 | `gap >= 4.2` 且 `h <= gap` | `gap >= h + 0.5` | 塞不进就明确不塞 |
| 塞不进时 | 半透明压字 | `overlap`：白底 0.92 小卡片 + 阴影，`top = 词底 - 1px`，`line-height: 1.05` | 卡片约 9.5px 高，与下一行重叠约 3px（实际压在字母顶部 1–2px 墨迹上） |
| 层级 | 文字层之上 | 图层 `z-index: 6`、高亮 1、标签 2 | 标签不会被 pdf.js 文字层盖住 |

单测：`plan({gap:5.37, baseFontSize:11.96})` → `mode='overlap'`、`fontSize=9`、`top = 212 - 1`；`plan({gap:14, pageFontSize:16})` → 字号 >11 且 ≤15；`plan({gap:14, pageFontSize:8})` → 仍取 9px 下限。

### 选区吸附到完整单词（v0.3.1 新增）

app 内实测：双击 `contains` 时 pdf.js 把词拆在多个 span 里，捕获到 `ontains`（7 字符），sidecar 里就是错的词。修法：

- `.textLayer` 的文本节点用 `TreeWalker` 拼成一条字符串并记下每个节点的区间（跨 span 也能定位）；
- `expandToWordBounds` 把起点向前、终点向后扩到 `[A-Za-z'’\-]` 之外，短语只扩首词开头与末词结尾；
- 用扩好的偏移重建 `Range`，并同步页面上的选区（用户看到的是整词）；
- 扩完仍判定为半截词（DOM 顺序异常）就**拒绝保存**并提示「没能取到完整单词，请重新选一次」；
- quoteBefore/quoteAfter 改成按索引切 ±48 字符，而不是 `indexOf`，避免重复词串位。

单测 `testSelectionSnap()` 11 条：`ontains → contains`、整词不变、短语只补首尾（`a map for the ideas in later chapters`）、括号边界、`state-of-the-art` 与 `agent's` 视为同一个词、行尾不变、**尾随空格不吞下一个词（`contain tank` 选到 `contain ` 只能得到 `contain`）**、行首空格被剥掉、尾随标点不进词。

app 内第二次实测：双击 `contain` 却存成 `contain tan`（高亮也盖住下一个词）。两个成因一起修：

- `expandToWordBounds` 先剥掉选区首尾的空白与标点再扩词——否则终点落在空格之后时，扩词循环会跨过空格把下一个词整个吞进来；
- `absoluteOffset` 增加 `bias` 参数：元素边界上的起点取「后一个子的首个文本」，终点取「前一个子的末尾文本」，不再一律按起点算；
- 兜底：若原始选区没有空格、扩完却有空格，只保留光标所在的那个词，高亮矩形同步收窄。

### 悬停浮标（v0.3.1 默认方式）

正文里不再放常驻标签，改为 hover 查询：

- 高亮层 `pointer-events: none`（点击穿透），所以在 PDF 里框选文字、双击取词都不受影响；
- 悬停判定不依赖 DOM 事件的 `mouseenter`，而是在 PDF 容器上监听 `pointermove`，把指针换算成页面比例坐标后用 `markAtPoint()` 命中标注矩形（容差 0.004 ≈ 2–3px，重叠时取 `updatedAt` 最新的那条）；
- 命中后就地重绘（`schedule(0)`，rAF 内完成），只画这一条浮标；指针移开或离开容器即清除；
- 浮标文案直接取 sidecar 里的 `translation`，**不触发任何模型请求**；
- 单测：命中、未命中（null）、重叠取新，共 3 条（`testMarks` 内）。

## 第 5 节验收条目逐条对照（PDF 词级标注，v0.3）

| # | 验收要求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 第 10 页选 correlated → 高亮 + 词下「相关的」 | **逻辑层通过，需 in-app 确认（默认改为 hover 浮标，不再常驻压字）** | `captureWordSelection` 现在先把选区吸附到整词（`expandToWordBounds`，8 条单测），再 `planLabel` 决定塞缝或切白色卡片（9px 下限）——上一次 app 内暴露的「捕获成 ontains」已修；实时用例实跑 `correlated → 相关`（qwen2.5:3b，热态 75ms），语义一致，具体字体渲染仍需 in-app 目视。 |
| 2 | journey / map / chapters 同一行多标签不互相覆盖 | **通过（逻辑层）** | `resolveCollisions` 单测：重叠 >12% 时只保留 priority 高（即 `updatedAt` 更新）的一条，悬停者优先；其余保留高亮。 |
| 3 | 100/125/150/200% 缩放标签贴住原词、按比例缩放 | **通过（逻辑层）** | 坐标以页面比例存（`normalizeRect` / `denormalizeRect` 往返单测）；每次重绘都用 `collectLineBoxes` 重测 gap，ResizeObserver 触发；需要 in-app 目视确认四种缩放。 |
| 4 | 翻页离开再回来标注恢复 | **通过（设计）** | 只绘可视页（视口 ±200px），`refresh()` 由 MutationObserver/scroll 触发，数据只来自 sidecar，不依赖 DOM 缓存。 |
| 5 | 关 PDF、重开 Obsidian 从 sidecar 恢复 | **通过（逻辑层）** | `VaultMarkStore` 用内存 fake adapter 做 save→load 往返：条数、译文一致；`parseMarkFile` 容错（坏 JSON、缺 rects、字符串页码、缺 id 补 `legacy-`）。 |
| 6 | `ollama stop` 两个模型后已有标注仍显示，只有重新标注报错 | **通过（设计）** | 渲染路径不调用 provider；`translateWordInContext` 失败抛「没有取到中文释义，请换一个模型或稍后重试」。 |
| 7 | 点标签改译文保存后立即更新，删除后消失 | **通过（设计）** | `WordMarkModal` → `updateMark` 改 `translation/updatedAt` → `saveMarks` + `overlay.refresh()`；`removeMark` 同理。需 in-app 点一次确认。 |
| 8 | 深色模式可读 | **部分通过** | 标签字色固定 `#1f2328`、overlap 时白底半透明，在任何主题下都是深字浅底；具体对比度需 in-app 目视。 |
| 9 | 跨页/超长选择明确提示不崩溃 | **通过（逻辑层）** | `captureWordSelection` 逐项拒绝：无选区 / 不在 PDF 内 / 跨页 / 无页码 / 超 `pdfMarkMaxChars` / 零尺寸 rect，各自返回中文 `message`；命令 checkCallback 在不可用时直接灰掉。 |
| 10 | 现有 69 项全过，新增覆盖坐标、gap、碰撞、id、sidecar、quote 重定位 | **通过** | 147 项全绿（离线 136 + 实时 11）；新分组见下。 |

## 新增测试分组（v0.3：53 项）

| 分组 | 项数 | 覆盖点 |
| --- | --- | --- |
| `geometry` | 19 | 归一化/反归一化往返、`canonicalRects` 稳定、零宽 rect 丢弃、行高 1.45 倍、重叠比例按较小面积、gap 模式落点与字号上限、水平居中、空隙不足降级 overlap、hover 不显示、页面底部改放上方、margin 靠右、超长文本缩到页宽、碰撞只留最新一条、互不相交全保留 |
| `marks` | 20 | `markId` 同位置稳定 / 换位置变、`marksPath` 形态（文件夹 / 同目录）、坏 JSON 空列表、缺 rects 丢弃、字符串页码转数字、缺 id 补 legacy、`findSameMark` 同位置复用 / 不同位置新建 / 不同页不混、`locateQuote` 三段/两段/单词、`VaultMarkStore` 写入与读回、`createMarkStore` 后端切换 |
| `word` | 14 | `wordModel` 回落与显式优先、`buildWordPrompt` 含选中词/上下文/12 字限制/术语表/只输出译文、`cleanWordTranslation` 去表格前缀/去「译文：」/去引号/去尾部词性/无中文返空/空串/超长截断 |

## 候选词覆盖（针对评审意见的回归）

评审指出 `correlated` 缺失不是设置问题，而是两处硬编码：`engine.ts` 的候选上限 `Math.min(maxItems, 16)` 和 `prompt.ts` 的 `slice(0, 12)`，配合「按出现顺序取前 N」，段落后半段的词永远进不了 prompt。改法：

| 改动 | 之前 | 现在 |
| --- | --- | --- |
| 采样方式 | 取前 N 个 | `sampleEven` 全文均匀取样（首/中/尾都覆盖） |
| 候选上限 | `min(maxItems, 16)` | `max(10, min(maxItems, 24))`，默认 20 |
| 传进 prompt 的上限 | 硬编码 12 | 24（候选本身不再被截） |
| 填充词 | 只去停用词 | 另去 `serves / later / developed / ideas` 等约 60 个高频填充词，把名额留给真正的难点词 |
| 缺失候选 | 静默丢弃 | `missingCandidates` 比对 → `backfillCandidates` 定向补译 → 仍缺则写进块内警告 |
| 模型整段答散文 | 直接空表 | 用 8 个候选词的短列表重试一次，并给警告 |

回归用例：`pickCandidates(text, 20)` 必须覆盖 `journey / map / chapters / correlated`；`pickCandidates(text, 12)` 必须含 `correlated`；`missingCandidates` 能识别 `Journey.` 这类带标点的已覆盖项。实时用例从「至少命中 2 个」升级为「四个全中」。

## 模型能力实测（决定了架构）

同一验收段落，同一个 prompt 结构，实测：

| 模型 | 完整 prompt（译文 + 词义） | 只问词义 |
| --- | --- | --- |
| `hy-mt2-1.8b-q8` | 6.0s，只输出 `【译文】`，`【词义】` 整段不存在 | 把英文原样吐回（6.3s）；给 few-shot 时只回 1 行 |
| `hy-mt2-7b-q5` | 26.9s，译文好，11 行词义格式脏，解析出 7 条 | 12.5s 只输出 1 行 |
| `qwen2.5:3b` | 10.1s，译文一般，词性列与释义列错位 | 7.9s，13 行干净词义 |

因此改成两段式：`buildTranslationPrompt` 只翻译，`buildGlossaryPrompt` 只做词义，两者可指向不同模型。词级标注沿用同一结论：用 `qwen2.5:3b` 做单词释义（一次一行；7.9s 的旧数据针对 13 行，实测单词请求冷启 2.5s、热态 59–77ms）。

## 解析器容错（都是实测踩出来的）

`qwen2.5:3b` 每次的排版都不一样，解析器逐步加了这些分支，每条都有单测：

- 无表头、无 markdown 表格的裸行：整段尝试当表格解析（`no-headers`）
- 无竖线裸行 `exploration v. 探索`
- 词性和释义挤一格：`state | n. 状态`
- 词性重复写进 source 列：`bandit n. / v. | n. | 抢劫犯`
- 编号/项目符号：`1. journey. | n. | 旅程`
- 长破折号当分隔符：`chapters —— n. —— 章节`
- 7B 用 `<br>` 拼行
- 模板占位符回显（`（这里写原文的中文译文）`）
- 前导空列：`| action | n. | 动作`

另外 `recoverCandidateItems` 用候选词表兜底：模型把行排歪、词性写到英文列、甚至整段格式崩掉时，只要那一行里有候选词和中文，就能把释义捞回来。

## 仍需在 app 内人工确认

自动化测试跑在 Node 里（`FetchTransport` + `obsidian-stub`），下面几条只有在 Obsidian 里操作才能验证：

1. 命令面板执行「为选中内容生成词义」→ 阅读视图渲染卡片，表格三列对齐
2. 关闭并重开笔记 → 词义块仍在，再次生成时弹「重新生成 / 删除」
3. 打开 PDF → 侧栏「译选中」→ 页码与卡片正常；关掉 Ollama 后卡片仍可读
4. 第 10 页双击 `contains` → 侧栏 8 个字符；鼠标停在词上浮出「包含」小卡片，移开消失，正文没被遮挡；高亮不挡框选（旧的那条 `ontains` 标注要先删掉重标）
5. `journey / map / chapters` 同一行三个标签的实际排布与降级行为
6. 100% / 125% / 150% / 200% 四种缩放下的贴合度
7. 深色主题下标签对比度（白底深字卡片）
8. 翻页离开再回来、关掉 PDF 重开、重启 Obsidian 后标注是否恢复

插件已安装到 `<vault>/.obsidian/plugins/interlinear-gloss/`，`community-plugins.json` 里已加入 `interlinear-gloss`；Obsidian 需要重载一次（`Ctrl+R` 或重启）才会加载 0.3.2（选区吸附：不再吞下一个词）。

## 覆盖范围汇总

单测 147 项（离线 136 + 实时 11），分组：

- 公式保护与还原（4）
- 分句与分块（5）
- 解析器（14）
- 术语表（6）
- prompt 结构（8）
- 候选词覆盖与缺失检测（6）
- 块插入 / 判重 / 替换 / 删除 / 定位 / 便携标记（12）
- PDF 缓存 id 与排序（3）
- 设置夹取与合并（5）
- PDF 词标几何与标签放置（24）
- PDF 词标存储、身份与悬停命中（23）
- 单词释义 prompt 与清洗（15）
- 选区吸附到完整单词（11）
- 真实 Ollama 集成（11）