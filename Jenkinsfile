pipeline {
    agent any

    environment {
        APP_DIR = '/opt/hr-ai-system'
        PM2_APP_NAME = 'hr-ai-system'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install Dependencies') {
            steps {
                dir("${APP_DIR}") {
                    sh 'npm install'
                }
            }
        }

        stage('Deploy') {
            steps {
                dir("${APP_DIR}") {
                    sh '''
                        if pm2 describe ${PM2_APP_NAME} > /dev/null 2>&1; then
                            echo "Restarting ${PM2_APP_NAME}..."
                            pm2 restart ${PM2_APP_NAME}
                        else
                            echo "Starting ${PM2_APP_NAME}..."
                            pm2 start server.js --name ${PM2_APP_NAME}
                        fi
                        pm2 save
                    '''
                }
            }
        }

        stage('Health Check') {
            steps {
                sh 'sleep 5'
                sh 'curl -f http://localhost:4000/ || exit 1'
            }
        }
    }

    post {
        success {
            echo 'HR AI System (Backend) deployment successful!'
        }
        failure {
            echo 'HR AI System (Backend) deployment failed!'
        }
    }
}
