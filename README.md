# ChatGuard - YouTube Chat Moderation Bot

## Overview

ChatGuard is an AI-powered bot designed to moderate YouTube live chat in real-time. It utilizes Genarative AI models like openAI or Gemini API and ensure a safe and positive environment for viewers.

## Features

- Real-time chat moderation: ChatGuard continuously monitors YouTube live chat and automatically moderates messages based on predefined criteria.
- AI-powered moderation: The bot employs advanced NLP models to detect and filter out inappropriate content, including spam, hate speech, and profanity.
- Notification system: ChatGuard alerts channel moderators or administrators of any actions taken, allowing for manual intervention if necessary.

## Setup

To deploy ChatGuard for your YouTube channel, follow these steps:

1. Clone this repository to your local machine.
2. Install the required dependencies using `npm install`.
3. Rename `.env.example` to `.env` and fill your YouTube API credentials along with AI API of prefered model.
4. Custamize moderation commends in `commands.js` file.
5. Run the bot using `npm start`.

