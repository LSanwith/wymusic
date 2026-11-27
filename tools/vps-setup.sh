#!/usr/bin/env bash
# 在你的服务器上跑一次，把存储服务装成常驻服务
#
#   sudo STORAGE_TOKEN='一串随机字符' bash tools/vps-setup.sh
#
# 做的事：
#   1. 建数据目录（默认 /opt/wymusic-data）
#   2. 写一个 systemd 服务，开机自启 + 崩溃自动重启
#   3. 启动它，并验证 /health 返回 ok
#
# 不会动你机器上已有的任何东西（除了新增这一个 systemd unit）。

set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/wymusic-data}"
PORT="${STORAGE_PORT:-8787}"
TOKEN="${STORAGE_TOKEN:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_JS="$(cd "$SCRIPT_DIR/.." && pwd)/server/storage-server.js"

if [ -z "$TOKEN" ]; then
  echo "缺少 STORAGE_TOKEN。用法："
  echo "  sudo STORAGE_TOKEN='一串随机字符' bash tools/vps-setup.sh"
  exit 1
fi

if [ ! -f "$SERVER_JS" ]; then
  echo "找不到存储服务文件：$SERVER_JS"
  echo "请先把这个仓库 clone 到服务器上，再在仓库里执行本脚本。"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "这台机器上没有 node。先装一个（Node 18 以上都行），例如："
  echo "  apt-get update && apt-get install -y nodejs"
  exit 1
fi

NODE_BIN="$(command -v node)"
NODE_VER="$(node -v)"
echo "使用 Node $NODE_VER ($NODE_BIN)"

echo "数据目录: $DATA_DIR"
mkdir -p "$DATA_DIR"

echo "写入 systemd 服务…"
cat >/etc/systemd/system/wymusic-storage.service <<EOF
[Unit]
Description=Wymusic storage server (TTML + file blobs)
After=network.target

[Service]
Type=simple
WorkingDirectory=$(dirname "$SERVER_JS")
Environment=STORAGE_PORT=$PORT
Environment=STORAGE_DIR=$DATA_DIR
Environment=STORAGE_TOKEN=$TOKEN
ExecStart=$NODE_BIN $SERVER_JS
Restart=always
RestartSec=3
# 内存上限，防止它拖垮同机的其他服务（你的机器只有 1.9G）
MemoryMax=384M
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable wymusic-storage >/dev/null 2>&1 || true
systemctl restart wymusic-storage

echo "等待启动…"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo ""
    echo "✓ 存储服务已跑起来"
    echo ""
    echo "Vercel 上要配的环境变量："
    echo "  KV_DRIVER         = remote"
    echo "  KV_REMOTE_URL     = http://<这台机器的公网IP>:$PORT"
    echo "  KV_REMOTE_TOKEN   = $TOKEN"
    echo "  BLOB_DRIVER       = remote"
    echo "  BLOB_REMOTE_URL   = http://<这台机器的公网IP>:$PORT"
    echo "  BLOB_REMOTE_TOKEN = $TOKEN"
    echo ""
    echo "数据目录: $DATA_DIR"
    echo "查看日志: journalctl -u wymusic-storage -f"
    exit 0
  fi
  sleep 1
done

echo "✗ 服务没起来。看日志："
echo "  journalctl -u wymusic-storage -n 50 --no-pager"
exit 1
