# pxder WebUI

单用户中文工作台：按作品 PID、画师 UID（均支持 Pixiv 链接）、公开/私密收藏、公开/私密关注抓取原图，也可更新索引和下载目录中已知的画师。任务、索引和 WebUI 保存的 Pixiv 凭据位于服务器 SQLite；刷新、关页不影响队列。原版 CLI 与 `master` 存档保留。

## 在服务器部署

最简单的方式是 Docker Compose v2：默认只绑定服务器的 `127.0.0.1`，通过 SSH 隧道访问，不要把明文 HTTP 端口直接开放到公网。

```bash
git clone --branch webui https://github.com/umeabc/pxder.git
cd pxder
```

在仓库目录新建 `.env`（仅服务器用户可读，比如 `chmod 600 .env`）。写入下列变量，把密码换成至少 16 位的独立强密码，可用 `openssl rand -hex 24` 生成。这个密码是 WebUI 管理员密码，不是 Pixiv 密码。

```dotenv
PXDER_PASSWORD=替换为强随机密码
PXDER_PORT=8080
```

```bash
docker compose up -d --build
docker compose ps
```

然后在自己的电脑上执行（修改 SSH 地址和用户名），浏览器访问 <http://127.0.0.1:8080>：

```bash
ssh -N -L 8080:127.0.0.1:8080 user@your-server
```

- **HTTPS 反代：** 如果用 Nginx/Caddy 在同一台服务器上公开访问，把域名的 HTTPS 流量转发到 `127.0.0.1:8080`，同时在 `.env` 中加 `PXDER_ORIGIN=https://pxder.example.com`（与浏览器地址完全一致，不带路径），重新执行 `docker compose up -d`。Nginx 上传上限设 `client_max_body_size 32m;`，并让代理读取超时不少于 65 秒。服务或代理应确保只有你能接触数据和凭据。
- **容器数据：** `/data` 是索引和任务卷，`/downloads` 是新图卷。可以用 `docker compose cp pxder:/downloads ./pxder-downloads` 复制新图到宿主机。如果要改用宿主机目录，请给容器用户 `1000:1000` 写权限，并选支持硬链接的文件系统（完成后原子发布，避免覆盖同名文件）。备份时先停止服务再备份卷。不要运行 `docker compose down -v`，它会删除卷。
- **不用 Docker：** 安装 Node.js 24 LTS，先运行 `npm ci --prefix web --omit=dev`，设置 `PXDER_PASSWORD` 后运行 `node web/server.js`。默认监听 `127.0.0.1:8080`；默认数据目录是 `.pxder-web/`，新图目录是 `downloads/`。可用 `PXDER_DATA_DIR`、`PXDER_DOWNLOAD_DIR`、`PXDER_PORT` 和 `PXDER_ORIGIN` 配置。不要多开实例共用同一数据卷。服务器须能访问 Pixiv 的 API 和图片 CDN。

## Pixiv 出站代理

直连失败时，在 **Pixiv 设置 → 出站代理** 输入 HTTP、HTTPS 或 SOCKS4/5 代理地址。用 **测试连通性** 分别检查 Pixiv API、登录和图片 CDN；这个测试不发送账号凭据。代理保存后即时生效，覆盖服务器的系统代理变量；可输入 `disable` 强制直连，或恢复系统代理设置。部署时也可用 `PXDER_PROXY` 固定代理，固定后网页只能查看和测试。代理地址中的用户名和密码不会回显；不要把代理凭据写入 Git。

## 导入已下载的图片记录

pxder 2.12.10 **没有下载数据库**。原 CLI 检查实际文件，以及动图 ZIP 等；AppData 的 `config.json` 是配置（可含登录凭据），不是历史；`protocol.json` 和 `update.json` 也不是图库。CLI 的 `download.path` 是默认下载根目录；如用过 `--output-dir`，需要另外扫描相应目录。

### 图片在本地，服务在远程：上传索引

在保留旧图的电脑上，从 `webui` 分支的仓库根目录运行。Windows 示例（把路径改成你的旧图库）：

```powershell
node web/export-library.js "I:\pixiv" "$env:USERPROFILE\Downloads\pxder-library.json"
```

然后在 WebUI → **旧库索引 → 上传本机旧库索引** 上传生成的 JSON。每次最多 32 MiB / 50 万条，较大的图库可以按目录分别导出。需要索引才可去重；**不上传图片**。索引仅含作品 ID、页码/媒体类型、以及从顶层 CLI 画师目录识别出的 UID；不含图片、原文件路径、作品标题或 Token。它仍是你的图库清单，不要公开提交或分享。重复导入同一份清单不会重复创建来源。

### 图片已放到服务器：只读扫描

在 `.env` 写入实际已有的服务器目录，例如 `PXDER_LIBRARY_HOST_DIR=/mnt/archive/pixiv`（容器用户须有读和遍历权限），并改用：

```bash
docker compose -f compose.yaml -f compose.library.yaml up -d --build
```

在 WebUI → **旧库索引 → 扫描服务器旧目录** 发起扫描。无容器时直接设置 `PXDER_LIBRARY_DIR` 为旧目录。扫描和移除索引不会移动或删除原图；重扫会替换上次扫描结果，扫描失败时保留旧结果。此功能不读取未知格式的 `.db` 文件。

## 首次下载前试筛一次

1. 在旧电脑的终端执行 `pxder --export-token`，复制 Pixiv Refresh Token，贴到 WebUI → **Pixiv 设置**。不要把 Token 贴进聊天、命令共享或 Git。保存前会向 Pixiv 验证。也可以用服务器变量 `PXDER_PIXIV_TOKEN` 管理凭据。索引导入不需要 Pixiv 登录。
2. 新建任务，先勾 **仅筛选**。它查询 Pixiv 元数据、比对 `(PID, 媒体类型, 页码)`，不下载图片。组图中已有的 `p0` 不会拦住缺失的 `p1`，动图 ZIP 独立计数。看过「已跳过 / 缺失」后可点 **补齐缺失图片**，重新筛选并只下载当前缺的内容。
3. 旧图库识别 `(PID)标题[_pN].jpg/png/gif/...`、`(PID)标题[@Nms].zip`、`PID_pN.ext` 和 `PID_ugoira宽x高.zip`。忽略零字节文件、部分文件、缩略图和软链接。任意改名的文件无法精确确认页码；索引是文件名识别，不对旧图做内容哈希。若删掉了旧图，需要更新相应索引。

## 测试

```bash
npm ci --prefix web --omit=dev
node --test web/test/*.test.js
```

测试使用本地临时目录与模拟 Pixiv，不会读取真实账号、写入真实图库或请求外网。浏览器流程见 `web/test/browser_smoke.py`（需要 Python Playwright）。
