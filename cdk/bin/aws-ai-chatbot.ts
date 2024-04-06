#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsAiChatbotStack } from '../lib/aws-ai-chatbot-stack';

const app = new cdk.App();
new AwsAiChatbotStack(app, 'AwsAiChatbotStack', {});