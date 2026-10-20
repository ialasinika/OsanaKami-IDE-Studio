# 缺口清单 2(2026-10-20:真实浏览器会话里抓到的三条,外加用户补充的一条体验缺口)

本文是 `docs/GAPS.md` 的追加,不动主清单的编号与结构。主清单第三轮(2026-10-18)的 14 条"仍然成立"全部来自代码审计;G51–G53 来自**同一天的动态验证**——两台常驻服务器(端口 8931/8932)+ Kimi Code 内置浏览器里真点真画,每条都有可重放的复现路径;G54 来自用户 2026-10-20 在同一轮里报告的窄窗口体验问题(见该行)。编号接主清单(G50 之后),便于将来合并。

快照:HEAD = `89759b9` 加未提交改动(同主清单第三轮),`make test` 全绿(check 19p/fullcheck 22p/probe/cli-check/version/path/installer/sign/C 测试,langs 91、web 294、mods 588、ai 86)。也就是说:这三条全部是**套件全绿时仍然成立**的缺口,每一条后面都写了该补什么检查、怎么先证红。

**第四轮已落地(2026-10-20,代码提交 `c416b01`):** 四条全部修掉并进主清单"已关闭"表——问题卡改用 `mod.validate` 回传的解析后 `root` 打开真实文件、点行带 `line`/JSON Pointer(G51-a、G16),mod 卡校验结果回流 problems 卡(G17),像素卡在 tile 首次显示时经 `shown()` 重新测量、取景算术搬进 `shell/web/pixelview.mjs` 并以光标像素为缩放锚(G52、G53),mod 卡分区可折叠且状态记在卡文档上(G54)。G51 的更深一层(内核拒绝 workspace 外路径)不是 bug,已作为 **G51-b** 留在主清单 B 区,等待产品决策。本文件保留为动态验证的原始证据,不再追加。

## 仍然成立(本轮逐条核实)

### E. 浏览器层:点击链路与画布状态

| 条目 | 当日证据(2026-10-20,动态复现) |
| --- | --- |
| G51 problems 卡行点击在 mods-root ≠ workspace 时全部打开失败 | 服务器以 `--workspace build/_demo_ws --mods-root build/_demo_ws/Mods` 启动,`problems Lantern` 后点任意行 → 编辑器报 `file.read Lantern/Defines/Character/Warden.json: file.read: no such file`。机理:`shell/web/cards/card-problems.mjs:45` 用 `app.openFile(modPath(root, target))`,`root` 是用户输入的原串(`card-mod.mjs:69` 的 `modPath` 拼成 workspace 相对路径),而 `mod.validate` 按 mods root 解析且响应**不含解析后的 root**(curl 验证响应键只有 `diagnostics/knowledge/manifest/ok/summary/types`)。mod 卡没这病,因为它用 `opened.root` 绝对路径(`card-mod.mjs:261-262`)。更深一层:内核硬性拒绝 workspace 外一切路径(`1003 path escapes the workspace`,协议级 curl 复现),所以 README 的真实游戏布局(游戏 Mods 在 workspace 之外)下点击打开**必然**被拒——只有 mods root ⊆ workspace 时链路才通。与 G16 是两层:G16 是"点到了但不跳行",本条是"根本点不开"。**为何套件没抓住**:`tools/input_smoke.py` 只点 D006 行,其目标精灵本来就故意缺失,读不出来是预期结果。修复方向:`mod.validate` 响应加 `root`(`shell/mods/index.js` 内部已有 `packageRoot`),problems 卡 paint 时优先用它;input_smoke 增加"点非 D006 行并断言编辑器读到内容",先证红 |
| G52 pixel 卡后台打开不重绘 | 命令行 `pixel Mods/Lantern/Sprites/Lantern.png` 在另一张卡(story)前台时执行 → 切到 pixel 标签,1x 画布全空;文件本身完好(Node 独立解码:437 个非透明像素)。点 zoom + 再 −(净 zoom 不变)强制一次 `paintCanvas` 后图像立刻出现。机理:`card-pixel.mjs` 的 `paintCanvas` 以 `surface.getBoundingClientRect()` 量画布,卡创建即隐藏时量到 0×0,兜底的一次 `requestAnimationFrame` 重绘在隐藏状态下照样跑完,之后**没有任何机制在标签切入时重新量尺寸**——`card-pixel.mjs:997-1007` 的注释自己写明 "Nothing re-measures after layout"。注意首次前台开卡(11:12 那次)无恙,所以这是"打开时机"依赖的 bug,手工 smoke 极易漏。修复方向:卡 handle 加 `shown()`/resize 钩子,视图切换前台时回调 `paint()`;`shell/web/selftest` 的 pixel 段补一条"hidden 布局后再 shown,画布尺寸跟随 surface"的纯几何检查,先证红 |
| G53 pixel 卡缩放锚点把小图甩出视野 | 1x 初始 pan (0,0),32×32 图贴画布左上角;点一次 + (2x) 图像即移出可视区,8x 时位于画布 CSS (-2786,-1106) 附近,画布看似"空的"。机理:`card-pixel.mjs:783` 的 `setZoom` 保持**画布中心点**不动,而初始状态画布中心对应的图像坐标 (≈398,≈158) 远在 32×32 图外;滚轮缩放(`:749-752`)走同一函数,标题提示的 "Ctrl+wheel" 实际不要求 Ctrl。用户视角:"一放大图就没了"。绕过方法(本轮实测):先用手型工具把图拖到画布中心再放大,之后 +/− 表现正常。修复方向:初始 paint 时把图像居中(pan 一次到位),或 `setZoom` 锚点改为光标位置/图像中心二选一;selftest 补"小图 zoom in 后图像仍与视口相交"的几何断言,先证红 |

### F. 体验:窄窗口下 mod 卡的分区收不起来

| 条目 | 当日证据(2026-10-20,用户报告) |
| --- | --- |
| G54 mod 卡的分区标题(mod.json / Defines / Yarn)不能收起,小屏时下面的分区够不到 | 用户报告(2026-10-20,同一轮体验反馈):"mod.json、Defines、YARN 等标签无法收起,在屏幕小的时候就容易无法触及下面的标签"。机理:`shell/web/cards/dom.mjs:144` 的 `section()` 只有标题 + 行容器,没有任何折叠状态;`style.css:1530` 起 `.mod-section` 全部 `flex: 1 1 auto`,而 `card-mod.mjs:246` 的分类区只有 `.mod-yarn` 分到 `flex: 1 1 auto`、row 列表各自滚动,**没有一个分区能折叠**,于是控制行(open/new/import/export/install/log 六排)在矮窗口里把分区高度压到标题行以下,Yarn 标题与行都贴到卡底、卡体 `overflow: hidden`(`style.css:467`)又不滚动,下面的分区既收不起来也滚不到。修复方向:分区标题加折叠开关(状态存卡文档的 `collapsed` 字段,重渲染后保持),折叠的分区只留标题行;`card-body-mod` 改为可滚动兜底;`selftest/cards.mjs` 补 `modSectionCollapsed`/`setModSectionCollapsed` 的纯状态检查 |

## 附:本轮动态验证覆盖到的面(均已闭环,非缺口)

- **rig 卡**(8931,`build/_ui_probe_spine_ws`):合并皮肤、动画播放、Edit 模式拖骨旋转并自动打关键帧、Save 写回 `.skel.bytes`(13349→13362 字节),Node 独立重解析确认新帧落盘。
- **mod 层**(8932,`build/_demo_ws`):problems 卡列出 2 errors/2 warnings/3 infos 并与校验器口径一致;mod 卡包树点开 define 进编辑器;docs 卡 `docs Love` 58 命中可点开;story 卡节点/翻译表联动。
- **pixel 卡四工具 + 撤销环 + 保存**:铅笔拖线(Bresenham 无断点)、取色器取到 `255,246,134`、油漆桶 4 向洪泛只染目标区域、橡皮擦成透明;Ctrl+Z/Ctrl+Shift+Z 走卡自己的环不牵动 board;save 后 Node 逐像素验证黄线位于第 2 列 7–25 行、颜色 `255,246,134,255`,共 19 像素,与其余像素无串扰。
- **环境备注**:本机 Edge 155 的 headless 完全坏掉(`--headless --dump-dom about:blank`、`--version` 均静默零输出),`make smoke` 因此失败——非产品回归,换 Chrome 或修 Edge 后应恢复;动态验证全程走 Kimi Code 内置浏览器,不受其影响。
