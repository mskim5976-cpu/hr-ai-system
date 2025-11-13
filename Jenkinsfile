pipeline {
    agent any

    environment {
        NODE_ENV = "production"
        PROJECT_DIR = "/root/hr-ai-system"
    }

    stages {
        stage('Checkout') {
            steps {
                echo "▶ Git 코드 체크아웃"
                // Jenkins Job 설정에서 이 Repo와 브랜치를 지정하면 Jenkins가 알아서 체크아웃함
                // 여기서는 Jenkinsfile 기준으로 진행
            }
        }

        stage('Install & Build') {
            steps {
                echo "▶ 배포 스크립트 실행 (백엔드+프론트+PM2)"
                sh '''
                  cd /root/hr-ai-system
                  ./deploy_all.sh
                '''
            }
        }
    }

    post {
        success {
            echo '✅ Jenkins 파이프라인 성공'
        }
        failure {
            echo '❌ Jenkins 파이프라인 실패 - 콘솔 로그 확인'
        }
    }
}
