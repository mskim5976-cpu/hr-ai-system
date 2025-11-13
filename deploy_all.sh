#!/bin/bash
set -e

PROJECT_DIR="/root/hr-ai-system"
FRONT_DIR="$PROJECT_DIR/hr-ai-client"

echo "▶ hr-ai-system 배포 시작"

cd "$PROJECT_DIR"

echo "▶ 백엔드 의존성 설치 (npm install)"
npm install

echo "▶ 프론트엔드 의존성 설치 및 빌드"
cd "$FRONT_DIR"
npm install
npm run build

echo "▶ PM2로 백엔드(server.js) 재시작"
cd "$PROJECT_DIR"
pm2 delete hr-api 2>/dev/null || true
pm2 start server.js --name hr-api

echo "▶ PM2로 프론트엔드(build) 정적 서비스 재시작 (포트 3000)"
cd "$FRONT_DIR"
pm2 delete hr-client 2>/dev/null || true
pm2 start serve --name hr-client -- -s build -l 3000

echo "✅ 배포 완료: 백엔드(hr-api), 프론트(hr-client)"
