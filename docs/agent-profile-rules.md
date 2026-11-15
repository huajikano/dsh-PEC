# DSH Agent 常驻指令：profile 文件修改规矩

> 用途：把本节内容粘贴进 DSH 里的 agent 常驻指令/系统提示，防止它修改 profile 文件时把 DSH 搞崩。
> 本机已发生三次同类事故（详见仓库 FIX_NOTES.md 与下文），每条都有对应自检方法。

## 规矩

1. **禁止用 PowerShell 直接写 JSON**：`Out-File` / `Set-Content` / `ConvertTo-Json` 的 UTF-8 输出带 BOM，会让 DSH 启动即崩（readProfileManifest 的 JSON.parse 撞 BOM）。改 `package.json` 等任何 JSON 用 node 写，或写完跑自检（见下）。

2. **改 `cordis.patch.yml` 时修改配置用「改原行」**：严禁对同一个键追加第二行（`disabled: true` 之类重复键会让 js-yaml 严格解析失败，应用无法启动）。本机已发生过一次：agent 两次追加到缓冲条目 → 重复键 → 应用死。

3. **每次修改 `cordis.patch.yml` / `package.json` 后必须语义自检**——确认没有把真实插件禁用、没有孤立键：

   ```powershell
   node -e "const y=require('js-yaml');const d=y.load(require('fs').readFileSync(process.env.USERPROFILE+'/.dsh/profiles/desktop/cordis.patch.yml','utf8').replace(/!!js\S*/g,'!!str'));console.log(d.filter(e=>e&&e.disabled).map(e=>e.id))"
   ```

   输出里出现 `subagent` / `dsh-pec` / `dsh-context` 等真实插件 = 改坏了，立即回退。

3. **dsh-windows-mcp 的标记块重写后检查孤立行**：`# <<< dsh-windows-mcp <<<` 结束标记之后如果出现孤立的 `disabled: true`，删掉它。（标记后已垫一个 no-op 条目 `- id: cc-dsh` 承接这个 bug 行——**勿删该条目**，它已卸载，禁不禁无影响。）

4. **出问题的急救顺序**：
   a. 应用打不开 → 先跑 `node <仓库>/scripts/fix-bom.cjs`（清 BOM）
   b. 还不行 → 看 crash 日志 + 对照 `FIX_NOTES.md`
   c. 检查 `cordis.patch.yml` 有没有孤立 `disabled: true` 或重复键/被禁用的核心插件（subagent / dsh-pec / dsh-context）

6. **改文件前先备份**：`cordis.patch.yml.bak-before-fix-<时间戳>`、`package.json.bak-bom-<时间戳>`

## 本机已发生的事故记录

- 2026-11-08：DSH 0.2.2 升级，旧预设引用失效（list-agents 子路径被合并）→ 修 cordis.patch.yml
- 2026-11-11 / 2026-11-12：agent 更新插件时用 PowerShell 写 package.json 带 BOM → 应用启动即崩（两次）
- 2026-11-15：agent 清理残留时留下孤立 disabled: true，缩进并入 subagent 条目 → 所有会话不可用
- 根因之一：dsh-windows-mcp 0.2.10 的块写入器模板 bug（每次重写追加孤立行）——已用 cc-dsh 缓冲条目兜住