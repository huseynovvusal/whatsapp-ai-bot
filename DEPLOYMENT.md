# 🚀 Deployment Guide

Complete guide for deploying the WhatsApp AI Bot using Docker.

## Table of Contents
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Configuration](#environment-configuration)
- [Docker Deployment](#docker-deployment)
- [Production Deployment](#production-deployment)
- [Monitoring & Maintenance](#monitoring--maintenance)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- Docker Engine 20.10+
- Docker Compose v2.0+
- At least 512MB RAM
- 1GB disk space

## Quick Start

### 1. Clone and Setup

```bash
git clone <your-repo>
cd whatsapp-ai-bot
cp .env.example .env
```

### 2. Configure Environment

Edit `.env` with your settings:

```bash
# Required
GEMINI_API_KEY=your-api-key-here
ADMIN_NUMBERS=1234567890,9876543210

# Generate admin password hash
node -e "console.log(require('bcryptjs').hashSync('your-secure-password', 10))"

# Add to .env
ADMIN_PASSWORD_HASH=<generated-hash>
SESSION_SECRET=<random-string-min-32-chars>
```

### 3. Deploy with Docker

```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f

# Check status
docker-compose ps
```

### 4. Connect WhatsApp

1. View logs: `docker-compose logs -f`
2. Scan QR code with WhatsApp
3. Bot is now connected!

### 5. Access Admin Panel

1. Open `http://localhost:3000/admin/login`
2. Login with configured credentials
3. Manage bot settings

## Environment Configuration

### Required Variables

```bash
# API Keys
GEMINI_API_KEY=your-key          # Get from https://ai.google.dev/
# OR
OPENAI_API_KEY=your-key          # For OpenAI
OPENAI_BASE_URL=https://...      # Optional, for DigitalOcean etc

# Admin
ADMIN_NUMBERS=1234567890         # Comma-separated phone numbers
ADMIN_USERNAME=admin             # Admin panel username
ADMIN_PASSWORD_HASH=<bcrypt>     # Generated hash
SESSION_SECRET=random-secret     # Min 32 characters
```

### Optional Variables

```bash
# Bot Configuration
BOT_NAME=@bot
MEMORY_WINDOW_MS=3600000
RATE_LIMIT_MAX_REQUESTS=2
RATE_LIMIT_WINDOW_MS=60000
ENABLE_PRIVATE_CHAT=true

# LLM Configuration
LLM_PROVIDER=gemini              # or "openai"
GEMINI_MODEL=gemini-1.5-flash
OPENAI_MODEL=gpt-4o-mini

# System
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
```

## Docker Deployment

### Using docker-compose (Recommended)

```bash
# Start in background
docker-compose up -d

# Stop
docker-compose down

# Restart
docker-compose restart

# View logs
docker-compose logs -f

# Update and restart
git pull
docker-compose build
docker-compose up -d
```

### Using Docker directly

```bash
# Build image
docker build -t whatsapp-ai-bot .

# Run container
docker run -d \
  --name whatsapp-bot \
  -p 3000:3000 \
  -v $(pwd)/auth_info_baileys:/app/auth_info_baileys \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  --env-file .env \
  whatsapp-ai-bot

# View logs
docker logs -f whatsapp-bot
```

## Production Deployment

### 1. Server Setup

```bash
# Install Docker on Ubuntu/Debian
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### 2. Security Hardening

```bash
# Use strong secrets
SESSION_SECRET=$(openssl rand -hex 32)

# Generate strong password
node -e "console.log(require('bcryptjs').hashSync('$(openssl rand -base64 16)', 10))"
```

### 3. Reverse Proxy (nginx)

```nginx
server {
    listen 80;
    server_name bot.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 4. HTTPS with Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d bot.yourdomain.com
```

### 5. Systemd Service (Alternative to Docker)

```ini
[Unit]
Description=WhatsApp AI Bot
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/whatsapp-bot
Environment="NODE_ENV=production"
ExecStart=/usr/bin/node build/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

## Monitoring & Maintenance

### Health Checks

```bash
# Check health endpoint
curl http://localhost:3000/health

# Expected response:
# {"status":"healthy","uptime":123,"timestamp":"..."}
```

### View Logs

```bash
# Docker logs
docker-compose logs -f

# App logs (if mounted)
tail -f logs/combined.log
tail -f logs/error.log
```

### Database Backup

```bash
# Backup database
docker-compose exec whatsapp-bot cp /app/data/whatsapp-bot.db /app/data/backup-$(date +%Y%m%d).db

# Or from host
cp data/whatsapp-bot.db data/backup-$(date +%Y%m%d).db
```

### Update Deployment

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## Troubleshooting

### Container won't start

```bash
# Check logs
docker-compose logs

# Check if port is in use
sudo lsof -i :3000

# Rebuild from scratch
docker-compose down -v
docker-compose build --no-cache
docker-compose up
```

### WhatsApp disconnects

```bash
# Delete session and re-scan QR
docker-compose down
rm -rf auth_info_baileys/*
docker-compose up -d
docker-compose logs -f  # Scan QR code
```

### Database issues

```bash
# Check database
docker-compose exec whatsapp-bot sqlite3 /app/data/whatsapp-bot.db ".tables"

# Backup and reset
mv data/whatsapp-bot.db data/whatsapp-bot.db.backup
docker-compose restart
```

### High memory usage

```bash
# Check memory
docker stats whatsapp-bot

# Restart container
docker-compose restart

# Limit memory in docker-compose.yml
services:
  whatsapp-bot:
    mem_limit: 512m
```

### Admin panel not accessible

```bash
# Check if container is running
docker-compose ps

# Check admin routes
docker-compose logs | grep "Admin"

# Verify credentials
echo "Check ADMIN_PASSWORD_HASH in .env"
```

## Performance Tips

1. **Use production mode**: Set `NODE_ENV=production`
2. **Enable WAL mode**: Already configured in SQLite
3. **Regular backups**: Schedule daily database backups
4. **Monitor logs**: Rotate logs to prevent disk fill
5. **Use nginx**: Add caching for static assets

## Support

For issues and questions:
- Check logs first: `docker-compose logs -f`
- Review troubleshooting section
- Check GitHub issues

## Security Checklist

- [ ] Strong `SESSION_SECRET` (min 32 chars)
- [ ] Secure `ADMIN_PASSWORD_HASH`
- [ ] HTTPS enabled in production
- [ ] Admin panel behind authentication
- [ ] Regular security updates
- [ ] Database backups automated
- [ ] Firewall configured (only ports 80/443 open)
- [ ] `.env` file not committed to git
