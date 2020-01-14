@Library('jenkins-joylib@v1.0.3') _

pipeline {

    agent none

    options {
        buildDiscarder(logRotator(numToKeepStr: '30'))
        timestamps()
    }

    stages {
        stage('top') {
            parallel {
                stage('v6-zone64') {
                    agent {
                        label joyCommonLabels(image_ver: '18.4.0')
                    }
                    tools {
                        nodejs 'sdcnode-v6-zone64'
                    }
                    stages {
                        stage('check') {
                            steps{
                                sh('make check')
                            }
                        }
                    }
                }
            }
        }
    }

    post {
        always {
            joyMattermostNotification()
        }
    }
}
