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

        stage('Pull Latest Code') {
            steps {
                dir("${APP_DIR}") {
                    sh '''
                        git config --global --add safe.directory ${APP_DIR}
                        git fetch origin develop
                        git checkout develop
                        git reset --hard origin/develop
                    '''
                }
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
                        echo "Restarting ${PM2_APP_NAME} (root pm2)..."
                        sudo pm2 restart ${PM2_APP_NAME} || sudo pm2 start server.js --name ${PM2_APP_NAME}
                        sudo pm2 save
                    '''
                }
            }
        }

        stage('Health Check') {
            steps {
                sh 'sleep 5'
                sh 'curl -f http://localhost:4040/ || exit 1'
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
