#!/bin/bash
set -e

PROJECT_DIR=~/hr-ai-system/hr-ai-client

cd "$PROJECT_DIR"

echo "▶ 최신 코드 받는 중 (옵션 – GitHub 쓰면 사용)"
# git pull origin main

echo "▶ 의존성 설치"
npm install

echo "▶ React 빌드"
npm run build

echo "▶ PM2로 정적 서버 재시작"
pm2 delete hr-client 2>/dev/null || true
pm2 start serve --name hr-client -- -s build -l 3000

echo "✅ 프론트 배포 완료 (포트 3000)"
