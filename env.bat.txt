@echo off
setlocal
title ViewerCount .env Generator

echo ========================================
echo       ViewerCount .env Generator
echo ========================================
echo.
echo Enter your values below.
echo Press ENTER to leave a value blank.
echo.

set /p "TWITCH_CLIENT_ID=Twitch Client ID: "
set /p "TWITCH_CLIENT_SECRET=Twitch Client Secret: "
set /p "TWITCH_USERNAME=Twitch Username: "

set /p "KICK_CLIENT_ID=Kick Client ID: "
set /p "KICK_CLIENT_SECRET=Kick Client Secret: "
set /p "KICK_USERNAME=Kick Username: "

set /p "RUMBLE_API_URL=Rumble API URL: "
set /p "RUMBLE_API_KEY=Rumble API Key: "
set /p "RUMBLE_CHANNEL=Rumble Channel: "

set /p "PLATFORM_SIDECAR_URL=Platform Sidecar URL: "
set /p "TIKTOK_USERNAME=TikTok Username: "

set /p "YOUTUBE_API_KEY=YouTube API Key: "
set /p "YOUTUBE_CHANNEL_ID=YouTube Channel ID: "

set /p "KICK_CHATROOM_ID=Kick Chatroom ID: "
set /p "KICK_PUSHER_APP_KEY=Kick Pusher App Key: "

set /p "INSTAGRAM_USERNAME=Instagram Username: "
set /p "INSTAGRAM_SESSION=Instagram Session: "
set /p "INSTAGRAM_LIVE_COMMENTS_URL=Instagram Live Comments URL: "

set /p "ALLOWED_ORIGIN=Allowed Origin: "

echo.
echo Creating .env...

(
echo TWITCH_CLIENT_ID=%TWITCH_CLIENT_ID%
echo TWITCH_CLIENT_SECRET=%TWITCH_CLIENT_SECRET%
echo TWITCH_USERNAME=%TWITCH_USERNAME%
echo.
echo KICK_CLIENT_ID=%KICK_CLIENT_ID%
echo KICK_CLIENT_SECRET=%KICK_CLIENT_SECRET%
echo KICK_USERNAME=%KICK_USERNAME%
echo.
echo RUMBLE_API_URL=%RUMBLE_API_URL%
echo RUMBLE_API_KEY=%RUMBLE_API_KEY%
echo RUMBLE_CHANNEL=%RUMBLE_CHANNEL%
echo.
echo PLATFORM_SIDECAR_URL=%PLATFORM_SIDECAR_URL%
echo TIKTOK_USERNAME=%TIKTOK_USERNAME%
echo.
echo YOUTUBE_API_KEY=%YOUTUBE_API_KEY%
echo YOUTUBE_CHANNEL_ID=%YOUTUBE_CHANNEL_ID%
echo.
echo KICK_CHATROOM_ID=%KICK_CHATROOM_ID%
echo KICK_PUSHER_APP_KEY=%KICK_PUSHER_APP_KEY%
echo.
echo INSTAGRAM_USERNAME=%INSTAGRAM_USERNAME%
echo INSTAGRAM_SESSION=%INSTAGRAM_SESSION%
echo INSTAGRAM_LIVE_COMMENTS_URL=%INSTAGRAM_LIVE_COMMENTS_URL%
echo.
echo ALLOWED_ORIGIN=%ALLOWED_ORIGIN%
echo PORT=3000
) > .env

echo.
echo ========================================
echo .env created successfully!
echo ========================================
echo.
echo IMPORTANT:
echo Do NOT upload .env to GitHub.
echo Do NOT share your .env file.
echo.
pause