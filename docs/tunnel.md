# 用 Cloudflare Tunnel 从公网访问 dsh-PEC

dsh-PEC 的网关默认监听本机所有网卡的 `7317` 端口，手机在**同一 Wi-Fi** 或 **Tailscale** 内可以直接访问（见 [tailscale.md](tailscale.md)）。但 Tailscale 要求手机和电脑**两端都装客户端**；如果手机装不了（公司管控、借来的设备、不想再装一个 App），可以改用 **Cloudflare Tunnel**：

- 电脑上常驻一个 `cloudflared` 守护进程，它**主动向外**连到 Cloudflare 的边缘节点；
- Cloudflare 把你域名的流量（例：`https://dsh.example.com`）经这条隧道送回电脑上的 `7317` 端口；
- 手机**只需要一个浏览器**，在任何网络（4G/5G、公司 Wi-Fi、酒店 Wi-Fi）打开网址即用，全程 HTTPS。

本文适用于**任何一台装了 dsh-PEC 插件的 Windows 电脑**，不限于哪台特定的机器；示例中的子域 `dsh.example.com` 换成你自己的即可。

> ⚠️ 这个方案会把网关放到公网上。网关背后是**电脑的执行权**（会话、终端、文件、审批），所以请先读完「安全提醒」一节再动手——尤其是第 1 条，它决定了 `config.yml` 应该怎么写。

---

## 和 Tailscale 方案怎么选

| | Tailscale（[tailscale.md](tailscale.md)） | Cloudflare Tunnel（本文） |
| --- | --- | --- |
| 手机要装东西吗 | 要装 App 并登录 | **不用，浏览器即可** |
| 电脑要装东西吗 | 要 | 要（cloudflared） |
| HTTPS | 无（局域网是明文 HTTP） | **有**（有效证书，自动续期） |
| 流量路径 | 两端点对点直连（打洞失败才走加密中继） | **经过 Cloudflare**（边缘解密后转发进隧道） |
| 公网暴露 | 无，网关始终在私网 | **有**，域名公网可达 |
| 依赖 | Tailscale 协调服务器可达 | **Cloudflare 可用**；免费计划无中国大陆节点，速度看线路 |
| 费用 | 个人免费 | 免费计划够用 |

一句话：**在家用为主、追求简单安全 → Tailscale；手机端要零安装、要现成 HTTPS → 本方案。** tailscale.md 附录里"公网隧道不推荐"指的正是本方案的风险——它"能用，但必须明白代价"，代价与对策都在安全提醒里。

## 前提

1. **域名已托管在 Cloudflare**：你的域名（例：`example.com`）的 NS 已指向 Cloudflare，免费计划即可。还没托管的话：Cloudflare 控制台 **Add a site** 按引导添加 → 回域名注册商把 NS 改成 Cloudflare 给的两条地址 → 等生效（几分钟到几小时）。
2. **电脑能上网**即可：不需要公网 IP，不需要动路由器的端口映射。
3. **dsh-PEC 插件正在运行**：

   ```powershell
   curl.exe http://127.0.0.1:7317/api/ping
   # {"ok":true,...} 即正常；端口被占用时插件会换随机端口，以 DSH 日志里打印的实际地址为准
   ```

4. 注册 Windows 服务那一步需要**管理员 PowerShell**。

---

## 一、电脑端：搭隧道

### 1. 安装 cloudflared

```powershell
winget install -e --id Cloudflare.cloudflared
```

装完**重开一个终端**，`cloudflared --version` 能打印版本号即可。

winget 不可用时，到 <https://github.com/cloudflare/cloudflared/releases/latest> 下载 `cloudflared-windows-amd64.exe`，改名 `cloudflared.exe` 放进某个 PATH 目录（或记住完整路径，下文命令全部用完整路径调用）。

### 2. 授权登录

```powershell
cloudflared tunnel login
```

会自动打开浏览器：登录 Cloudflare 账号 → 选择域名 `example.com` → 授权。证书落在 `%USERPROFILE%\.cloudflared\cert.pem`，它证明"你有权给这个域名建隧道"，保管好。

### 3. 创建隧道

```powershell
cloudflared tunnel create dsh-pec
```

输出里记下两样东西：

- 隧道 UUID，如 `Created tunnel dsh-pec with id 1a2b3c4d-...`；
- 凭据文件路径，如 `C:\Users\你\.cloudflared\1a2b3c4d-....json` —— **下一步要用完整路径**。

### 4. 写配置文件

新建 `%USERPROFILE%\.cloudflared\config.yml`：

```yaml
tunnel: dsh-pec
credentials-file: C:\Users\你\.cloudflared\1a2b3c4d-....json

ingress:
  - hostname: dsh.example.com
    service: http://localhost:7317
  - service: http_status:404
```

- `credentials-file` 用上一步打印的**完整路径**；
- 最后那条 `http_status:404` 是必须的兜底规则；
- 插件端口改过的话，`7317` 一起改。

> ℹ️ **关于 `localhost` 写法的鉴权**：插件 v2.0.4 起已在网关侧识别隧道流量（`CF-Connecting-IP` 头），经隧道进来的请求不再被当作"本机所有者"，设备令牌与配对码照常生效——`localhost` 写法可以直接用。下面的"更安全写法"是可选加固：让隧道流量绕开回环判定路径，并在网关故障时不受本机进程影响，两者只差一行。

### 5. 可选加固：指向局域网 IP

`localhost` 写法在 v2.0.4+ 已可放心使用。若想再加固一层（隧道流量不进回环判定路径），把 `service` 的目标换成**电脑的局域网 IPv4**：

```yaml
ingress:
  - hostname: dsh.example.com
    service: http://192.168.1.100:7317   # 换成你电脑的局域网 IP
  - service: http_status:404
```

```powershell
ipconfig   # 看"无线局域网适配器 WLAN"或"以太网适配器"的 IPv4 地址
```

只改这一行，效果是：隧道流量进入网关时不再被当作"本机所有者"，插件的**设备令牌和 6 位配对码重新生效**（手机第一次通过域名打开时会要求输配对码，见第三节）。配套两件小事：

- 路由器里给这台电脑做 **DHCP 保留**（或设静态 IP），否则 IP 一变隧道就 502；
- 如果隧道日志里出现连不上 7317 的报错，按 [tailscale.md](tailscale.md) 的命令放行 7317 入站防火墙。

另一种等效做法是把 cloudflared 跑在局域网里另一台常开的设备（NAS 等）上，`service` 指向电脑的局域网地址——同样恢复正常鉴权。

### 6. 添加 DNS 路由

```powershell
cloudflared tunnel route dns dsh-pec dsh.example.com
```

会在 Cloudflare DNS 里自动建一条 `dsh.example.com → <隧道UUID>.cfargotunnel.com` 的 CNAME。提示记录已存在的话，去 Cloudflare 后台 **DNS** 删掉同名旧记录再跑一遍。

### 7. 手动跑一次

```powershell
cloudflared tunnel run dsh-pec
```

看到若干行 `Registered tunnel connection` 就是通了。此时手机浏览器打开 `https://dsh.example.com` 应能看到 dsh-PEC 的页面。确认后 `Ctrl+C` 停掉，接着注册服务。

### 8. 注册为 Windows 服务（开机自启）

**管理员 PowerShell**：

```powershell
cloudflared service install
```

服务以 SYSTEM 账户运行，它读的配置目录是 `C:\Windows\System32\config\systemprofile\.cloudflared\`，**不是**你登录用户的 `%USERPROFILE%\.cloudflared\`。把文件复制过去再重启服务：

```powershell
New-Item -ItemType Directory -Force "$env:SystemRoot\System32\config\systemprofile\.cloudflared" | Out-Null
Copy-Item "$env:USERPROFILE\.cloudflared\*" "$env:SystemRoot\System32\config\systemprofile\.cloudflared\" -Force
Restart-Service cloudflared
Get-Service cloudflared   # Running 即正常
```

> 跳过复制是最常见的坑：服务显示 Running，手机打开却是 530 错误——SYSTEM 账户找不到凭据文件。
>
> 另一条路是"网页托管式"隧道：在 Cloudflare Zero Trust 后台建隧道拿 token，`cloudflared service install <token>`，配置全在网页上做，可避开上面的路径问题。两种方式选其一即可。

### 9. 验证

```powershell
cloudflared tunnel info dsh-pec                     # 隧道状态与活跃连接
curl.exe https://dsh.example.com/api/ping          # 从公网绕一圈回来
```

第二条返回 `{"ok":true,...}` 说明"域名 → Cloudflare → 隧道 → 电脑网关"整条链路通了。

---

## 二、手机端

**什么都不用装。** 手机浏览器（推荐 Chrome / Edge）打开：

```
https://dsh.example.com
```

建议在浏览器菜单里选「**添加到主屏幕**」，以后从图标进入，观感接近 App。此后无论手机在哪张网上都这样访问；换浏览器或清了 Cookie 之后需要重新配对。

dsh-PEC 的 Android APK 也可以直接填 `https://dsh.example.com` 作为地址；如果遇到证书或登录问题，用浏览器访问即可，网页版与 App 功能一致。

---

## 三、配对与使用

**推荐顺序：先在家里（局域网内）配好第一台手机，再把隧道开起来。**

插件的"首次配对免码"只对**私有网段来源**生效（家里 Wi-Fi、Tailscale 网段；见 `lib/gateway.js` 的 `isPrivateAddress`）。只要电脑上**已经配过至少一台设备**，之后再配对就必须输 6 位码——所以先在家里把"第一次"用自己的手机用掉，公网上就没有免码配对的机会了。

1. **家里**：手机连同一 Wi-Fi，App 或浏览器访问 `电脑IP:7317`，配对码留空，点「连接」；
2. 确认插件正常后，按「一、电脑端」把隧道搭起来；
3. **以后加新手机 / 换手机**：电脑端 DSH **设置 → 手机连接** 查看 6 位配对码（每 10 分钟轮换、一次有效），手机打开 `https://dsh.example.com`，在配对页输码，点「连接」；
4. 日常使用与局域网完全一致：会话、对话、终端、文件、审批都在；人在外面用「强制模式」接管审批，回到电脑前记得处理弹窗。

> 两种 `config.yml` 写法对应两种体验：
>
> - **局域网 IP 写法（推荐）**：手机第一次通过域名打开会停在配对页，输电脑上显示的 6 位码即完成配对，之后凭设备令牌免密；
> - **`localhost` 写法**：隧道流量在插件眼里等于"坐在电脑前"，手机打开直接进完整界面、不问配对码——方便，但公网上的任何人都一样（安全提醒第 1 条），这种写法**必须**搭配 Cloudflare Access。

---

## 四、验证与排错

### 连通性

```powershell
cloudflared tunnel info dsh-pec              # 有活跃连接说明隧道在
Get-Service cloudflared                      # 服务是否 Running
curl.exe http://127.0.0.1:7317/api/ping      # 本机直连网关
curl.exe https://dsh.example.com/api/ping   # 走公网整条链路
```

第三条通、第四条不通 → 问题在隧道或 Cloudflare；第三条就不通 → 问题在网关/插件本身。

### 看日志

排错时先停服务，前台跑一遍，日志直接打在终端：

```powershell
# 管理员 PowerShell
Stop-Service cloudflared
cloudflared tunnel run dsh-pec --loglevel debug
# 看完 Ctrl+C，再 Start-Service cloudflared 恢复
```

### 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 手机打开显示 Cloudflare 530 / 1033 | 隧道没连上：服务没起、SYSTEM 账户读不到凭据（见第 8 步的复制命令）、或 `config.yml` 里隧道名/凭据路径写错 |
| 522 | Cloudflare 连不到你的 cloudflared：电脑断网、cloudflared 进程挂了、或所在网络拦出站连接 |
| 524 | 隧道通，但网关超时没响应：DSH 忙/假死，重启 DSH 试试 |
| 502 | 隧道通，但 7317 没在监听：DSH 没开、插件被禁用，或端口被占换成了随机端口——看 DSH 日志里的实际地址，同步改 `config.yml` 后 `Restart-Service cloudflared` |
| `ERR_TOO_MANY_REDIRECTS` | 多为浏览器端 Cookie 异常：先用无痕窗口验证，清掉 `dsh.example.com` 的 Cookie；若配置过 Access 或重定向规则，检查是否自相矛盾（比如把登录页本身也拦了） |
| `route dns` 提示记录已存在 | Cloudflare DNS 后台删掉同名旧记录（或换个子域）重跑 |
| 手动 run 正常、服务不正常 | SYSTEM 路径坑：按第 8 步复制文件后重启服务 |
| 配对页提示配对码不对 | 配对码 10 分钟轮换、一次有效：回电脑 **设置 → 手机连接** 看当前码，或点面板上的「换一个配对码」立即换新 |
| 时通时断、偶尔 522 | 家里宽带到 Cloudflare 的线路波动（免费计划无中国大陆节点）；对稳定性要求高就换 Tailscale |
| 想临时关掉 | 管理员 PowerShell 里 `Stop-Service cloudflared`，用完 `Start-Service cloudflared` |

### 安全提醒（重点，开隧道前必读）

1. **鉴权与隧道的关系（v2.0.4 起已内置防护）**：网关原本把"来自本机回环的请求"一律当作电脑所有者（`lib/gateway.js` 的 `#owner`），而 cloudflared 恰好在本机回环上转发隧道流量——不设防的话，隧道进来的每个请求都会被当成"电脑主人"。**v2.0.4 起网关已识别隧道流量**：带 `CF-Connecting-IP` 头（Cloudflare 转发特征）的请求不再享受回环特权，设备令牌与配对码照常生效。因此 `localhost` 写法可以直接用。两条可选加固：
   - **改用局域网 IP 写法**（第 5 步），让隧道流量彻底绕开回环判定路径（老版本插件的必选项）；
   - **加 Cloudflare Access**（下条），把能走到网关面前的人限定成你自己——纵深防御，推荐。

2. **Cloudflare Access（免费 Zero Trust，强烈建议）**：给域名加一道身份前置，未通过验证的访问者在 Cloudflare 边缘就被挡下，根本到不了插件。设置：Cloudflare 后台 → **Zero Trust** → **Access → Applications → Add → Self-hosted**，域名填 `dsh.example.com`；策略选 Allow，Include 里加 **Emails** 填你自己的邮箱（One-time PIN 验证；也可以接入 GitHub 等身份源并限定你的账号）。手机第一次打开会收验证码，通过后长期免打扰。设了 Access 之后，APK 外壳若被登录页拦住，先用手机浏览器完成一次验证，或直接用网页版。

3. **确认设备列表**：公网可达期间，养成习惯到 DSH **设置 → 手机连接** 检查已配对设备（名称、平台、配对时间、最后在线）；不认识或不再用的设备**立即移除**，移除后其令牌立刻失效。

4. **先配对、后开隧道**：确保电脑上至少有一台自己的已配对设备，再让隧道对公网开放（见第三节），不给"第一个连上来的人免码配对"留机会。

5. **Cloudflare 的缓存与限制**：dsh-PEC 的 API 都是动态请求（含 SSE 长连接），Cloudflare 默认不缓存它们；SSE 每 20 秒有心跳（`lib/gateway.js:306`），不会触发边缘空闲超时，断流会自动重连；免费计划单次上传上限 100 MB，发图片不受影响；免费计划无中国大陆节点，国内访问速度看线路——介意就选 Tailscale。

### 本机（跑 DSH 的电脑）浏览器打不开域名？

如果这台电脑开着 Clash / Surge 等 TUN 模式代理：代理会接管域名解析（返回 198.18.x.x 假 IP）并按规则把流量送进代理隧道，与 Cloudflare 边缘的 TLS 握手可能失败——表现就是本机浏览器打不开 `https://dsh.example.com`，但 `http://localhost:7317` 正常，且**手机（流量网络）完全不受影响**。

处理任选其一：

- 本机要用就直接开 `http://localhost:7317`（人都在电脑前了，不需要走域名）；
- 在代理软件里加一条规则：`DOMAIN-SUFFIX,example.com,DIRECT`，让这个域名直连不走代理（Cloudflare 边缘国内可直连）；
- 或对该域名关闭 TUN 接管。

这不是插件或隧道故障——连接器（cloudflared 服务）与 Cloudflare 的出站连接不经过代理软件，手机端始终正常。

### 恢复码：异地令牌丢失时的保险

先设想一个最难受的场景：人在外地，手机浏览器里存的设备令牌丢了——清了浏览器数据、换了浏览器、或换了手机——配对页要你输 6 位配对码，而配对码只显示在电脑的 DSH 面板上，你**看不到电脑**。没有恢复码，这时只能等回到电脑前。

**提前准备（现在就做，一分钟）**：电脑上打开 DSH **设置 → 手机连接**，找到「恢复码（异地重新配对用）」卡片，点「**生成恢复码**」——得到一串 16 位数字（4 个一组，形如 `1234-5678-9012-3456`）。**截图保存或抄下来**，放进你的密码管理器。生成后卡片会一直显示"已设置"状态，电脑上不再明文展示这串数字。

**异地使用**：手机令牌丢失后打开 `https://dsh.example.com`，在配对页点「**使用恢复码重新配对（令牌丢失时）**」，输入保存的恢复码，点「连接」即可拿到新的设备令牌——全程不需要碰电脑。同一浏览器重新配对会自动顶替同设备的旧记录，设备列表不会堆积重复项。

几条安全特性，都是硬设计：

- **电脑上只存哈希**：恢复码生成后电脑端只保留 SHA-256，明文只在你截图的那一刻存在过；
- **一次有效**：每次用恢复码配对成功，旧码立即作废，配对响应里会返回一个**全新的恢复码**——看到后**马上重新截图保存**，别拿旧码当传家宝；
- **随时作废**：怀疑泄露或不再需要，在「手机连接」的恢复码卡片里点「**删除恢复码**」即失效，之后可重新生成。

> 恢复码等同一次配对权限：拿到它的人（配合能访问到域名的网络）就能把设备配到你的电脑上。和配对码一样妥善保管；怀疑泄露就立刻删除重生成。恢复码依赖"配对页"存在：v2.0.4 起网关识别隧道流量，`localhost` 与局域网 IP 两种写法下配对页都照常出现，恢复码都能用；更老的插件配合 `localhost` 写法时隧道请求被视为电脑所有者、没有配对页，恢复码也就无从使用——遇到这种情况先升级插件。

### 拆除

不用了就拆干净（管理员 PowerShell）：

```powershell
Stop-Service cloudflared
cloudflared service uninstall
cloudflared tunnel cleanup dsh-pec
cloudflared tunnel delete dsh-pec
```

再到 Cloudflare 后台 **DNS** 删除 `dsh.example.com` 的 CNAME（用 Zero Trust 网页建隧道的话，在 Zero Trust → Networks → Tunnels 里删除），最后到 DSH **设置 → 手机连接** 清理不用的设备。

---

## 附：管理端准备（仅开发者 / 维护本仓库的人）

普通用户照上面做完就结束了。若你在装了隧道的这台电脑上维护 dsh-PEC 本地安装，仓库自带两个脚本：

**更新本地插件**（把 profile 依赖钉到发布 tag，再 pnpm 拉取；默认 profile 是 `%USERPROFILE%\.dsh\profiles\desktop`，别的电脑用 `-ProfileDir` 指定）：

```powershell
pwsh ./scripts/sync-local.ps1 -Version v2.0.3          # 更新到指定 tag
pwsh ./scripts/sync-local.ps1 -Version v2.0.3 -Reload  # 更新并尝试热重载
```

- `web/*` 的改动刷新手机页面即生效；`lib/*` 的改动需要 toggle 插件（或加 `-Reload`）；
- `-Reload` 走网关 API 开关插件，中途断了可能卡住插件 fiber——重启 DSH 总能恢复；
- 脚本结束会自动打 `/api/health` 自检；隧道开着时，手机端刷新页面即见新版本。

**修复 profile 文件的 BOM**（PowerShell 5 的 `Set-Content -Encoding UTF8` 会给 JSON/YAML 写 UTF-8 BOM，profile 的 package.json 带 BOM 会让 DSH 启动即崩）：

```powershell
node scripts/fix-bom.cjs [profileDir]   # 不带参数默认 %DSH_HOME%\profiles\desktop
```

扫描 profile 根目录下的 JSON/YAML，发现 BOM 就移除（自动留 `.bak-bom-*` 备份）。

---

## 附：本机 cordis.patch.yml 的缓冲条目（勿删）

本机的 patch 末尾（`# <<< dsh-windows-mcp <<<` 结束标记之后）有一个 **`- id: cc-dsh`** 的 no-op 条目，带注释说明。它是给 **dsh-windows-mcp 0.2.10 的块写入器** 垫的缓冲：该写入器每次重写自己的标记块，都会在结束标记后追加一行孤立的 `disabled: true`（模板 bug），没有缓冲时这行会按 YAML 缩进并进上一个真实插件条目——曾把核心的 subagent 插件禁用，导致所有会话不可用。cc-dsh 已卸载，禁用它无任何影响。**维护 patch 时勿删这个条目**；改完 patch 跑一次结构自检（确认无孤立 disabled 行）。

## 附：回归 Tailscale

装得了 Tailscale 的话，[tailscale.md](tailscale.md) 的方案始终更简单也更安全：两端进同一个虚拟私网、流量不过第三方、网关不出私网、不存在"公网谁都能敲一下"的问题。本方案只服务"手机端零安装 + 现成 HTTPS"这一个特定需求。
