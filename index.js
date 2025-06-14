require('dotenv').config();

const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
    // GitHub Integration (DISABLED by default)
    GITHUB_ENABLED: (process.env.GITHUB_ENABLED || 'false')=='true',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
    GITHUB_OWNER: process.env.GITHUB_OWNER || 'ItsThatOneJack-Dev',
    GITHUB_REPO: process.env.GITHUB_REPO || 'BetterRugplay-tags',
    GITHUB_FILE_PATH: process.env.GITHUB_FILE_PATH || 'reportsystem.json',
    
    // Discord Webhook
    REPORTS_WEBHOOK: process.env.REPORTS_WEBHOOK || "",
    ACTIONS_WEBHOOK: process.env.ACTIONS_WEBHOOK || "",
    
    // Auth
    SALT_ROUNDS: process.env.SALT_ROUNDS || "12", // ~100ms/password

    // Rate limiting
    REPORT_RATE_LIMIT: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 5, // limit each IP to 5 requests per windowMs
        message: { error: 'Too many reports from this IP, please try again later.' }
    }
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enable CORS for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// In-memory storage (replace with database in production)
let reports = [];
let actionedReports = [];

// GitHub client setup
let octokit = null;
if (CONFIG.GITHUB_ENABLED && CONFIG.GITHUB_TOKEN) {
    octokit = new Octokit({
        auth: CONFIG.GITHUB_TOKEN,
    });
}

// Rate limiter for reports
const reportLimiter = rateLimit(CONFIG.REPORT_RATE_LIMIT);

// Utility functions
function generateReportId() {
    return crypto.randomBytes(8).toString('hex');
}


async function FireWebhook(Content,URL) {
    try {
        const fetch = (await import('node-fetch')).default;
        
        const payload = {content: Content};
        
        const startTime = Date.now();
        const response = await fetch(URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });
        const endTime = Date.now();
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[WEBHOOK] Discord API returned error:');
            console.error('[WEBHOOK] Error response:', errorText);
        }
        
    } catch (error) {
        console.error('[WEBHOOK] Critical error in sendDiscordWebhook:');
        console.error('[WEBHOOK] Error name:', error.name);
        console.error('[WEBHOOK] Error message:', error.message);
        console.error('[WEBHOOK] Error stack:', error.stack);
        
        // Check for common error types
        if (error.code === 'ENOTFOUND') {
            console.error('[WEBHOOK] Network error - DNS resolution failed');
        } else if (error.code === 'ECONNREFUSED') {
            console.error('[WEBHOOK] Connection refused by Discord');
        } else if (error.code === 'ETIMEDOUT') {
            console.error('[WEBHOOK] Request timed out');
        }
    }
}

async function addToGitHubBanList(reportData) {
    if (!CONFIG.GITHUB_ENABLED || !octokit) {
        console.log('GitHub integration disabled.');
        return;
    }
    
    try {
        // Get current file
        let currentFile;
        let currentSha;
        let bannedUsers = [];
        
        try {
            const response = await octokit.rest.repos.getContent({
                owner: CONFIG.GITHUB_OWNER,
                repo: CONFIG.GITHUB_REPO,
                path: CONFIG.GITHUB_FILE_PATH,
            });
            
            currentFile = Buffer.from(response.data.content, 'base64').toString();
            currentSha = response.data.sha;
            bannedUsers = JSON.parse(currentFile).banned_users || [];
        } catch (error) {
            // File doesn't exist, create new structure
            console.log('File not found, creating...');
        }
        
        // Add new banned user
        const newBanEntry = {
            target_id: reportData.target,
            reporter_id: reportData.reporter,
            reason: reportData.reason,
            context: reportData.context,
            date_added: new Date().toISOString(),
            report_id: reportData.id
        };
        
        bannedUsers.push(newBanEntry);
        
        const newContent = JSON.stringify({
            banned_users: bannedUsers,
            last_updated: new Date().toISOString()
        }, null, 2);
        
        // Update file
        await octokit.rest.repos.createOrUpdateFileContents({
            owner: CONFIG.GITHUB_OWNER,
            repo: CONFIG.GITHUB_REPO,
            path: CONFIG.GITHUB_FILE_PATH,
            message: `Add banned user ${reportData.target} - Report ${reportData.id}`,
            content: Buffer.from(newContent).toString('base64'),
            sha: currentSha,
        });
    } catch (error) {
        console.error('GitHub integration error:', error);
    }
}

// Routes

// POST /report - Submit a report
app.post('/report', reportLimiter, (req, res) => {
    const { target, reporter, context, reason } = req.body;
    
    // Validate input
    if (target === undefined || target === null || reporter === undefined || reporter === null || !context) {
        console.log('❌ [REPORT] Validation failed - missing fields.');
        return res.status(400).json({ 
            error: 'Missing required fields: target, reporter, context, reason' 
        });
    }
    
    // Convert to numbers and validate
    const targetNum = typeof target === 'number' ? target : Number(target);
    const reporterNum = typeof reporter === 'number' ? reporter : Number(reporter);
    
    if (isNaN(targetNum) || isNaN(reporterNum) || typeof context !== 'string') {
        console.log('[REPORT] Validation failed - invalid types.');
        return res.status(400).json({ 
            error: 'Invalid field types: target and reporter must be valid numbers, context must be string' 
        });
    }
    
    const report = {
        id: generateReportId(),
        target: targetNum,
        reporter: reporterNum,
        context: context.trim(),
        reason: reason.trim(),
        timestamp: new Date().toISOString(),
        ip: req.ip,
        status: 'pending'
    };
    reports.push(report);
    FireWebhook(`**New Report**\n\nTotal pending reports: **${reports.length}**\n\nCheck reports at: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/reports`, CONFIG.REPORTS_WEBHOOK);
    
    res.status(201).json({ 
        success: true, 
        message: `Report ${report.id} submitted successfully!`,
        report_id: report.id
    });
});

// All other methods to /report redirect to /reports
app.all('/report', (req, res) => {
    res.status(301).redirect('/reports');
});

// GET /reports - View reports (requires auth)
app.get('/reports', (req, res) => {
    // Replace the existing res.send() content in your GET /reports route with this:
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Report Management System - ItsThatOneJack</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: #0a0a0a;
                color: #ffffff;
                overflow-x: hidden;
                line-height: 1.6;
                min-height: 100vh;
            }

            /* Animated Wave Background */
            .wave-container {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                overflow: hidden;
                z-index: 1;
                pointer-events: none;
            }

            .wave {
                position: absolute;
                width: 200%;
                height: 200%;
                background: linear-gradient(45deg, 
                    rgba(139, 92, 246, 0.08) 0%,
                    rgba(168, 85, 247, 0.08) 25%,
                    rgba(139, 92, 246, 0.05) 50%,
                    rgba(168, 85, 247, 0.03) 75%,
                    transparent 100%);
                border-radius: 45%;
                animation: wave-rotate 25s linear infinite;
            }

            .wave:nth-child(2) {
                background: linear-gradient(-45deg, 
                    rgba(168, 85, 247, 0.05) 0%,
                    rgba(139, 92, 246, 0.05) 25%,
                    rgba(168, 85, 247, 0.03) 50%,
                    transparent 75%);
                animation-duration: 30s;
                animation-direction: reverse;
            }

            @keyframes wave-rotate {
                0% { transform: rotate(0deg) scale(1); }
                50% { transform: rotate(180deg) scale(1.1); }
                100% { transform: rotate(360deg) scale(1); }
            }

            /* Navigation */
            .nav {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                z-index: 1000;
                padding: 20px 40px;
                background: rgba(10, 10, 10, 0.9);
                backdrop-filter: blur(20px);
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }

            .nav-container {
                display: flex;
                justify-content: space-between;
                align-items: center;
                max-width: 1400px;
                margin: 0 auto;
            }

            .logo {
                font-size: 24px;
                font-weight: 700;
                color: #ffffff;
            }

            .nav-title {
                color: rgba(255, 255, 255, 0.8);
                font-size: 18px;
                font-weight: 500;
            }

            /* Main Container */
            .container {
                position: relative;
                z-index: 10;
                max-width: 1400px;
                margin: 0 auto;
                padding: 120px 20px 40px;
                min-height: 100vh;
            }

            .main-card {
                background: rgba(15, 15, 15, 0.9);
                border-radius: 20px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(20px);
                overflow: hidden;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            }

            .header {
                padding: 40px;
                text-align: center;
                background: linear-gradient(135deg, rgba(139, 92, 246, 0.1), rgba(168, 85, 247, 0.1));
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }

            .header h1 {
                font-size: 48px;
                font-weight: 800;
                margin-bottom: 16px;
                background: linear-gradient(135deg, #ffffff, #cccccc);
                background-clip: text;
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }

            .header p {
                font-size: 18px;
                color: rgba(255, 255, 255, 0.7);
                max-width: 600px;
                margin: 0 auto;
            }

            /* Authentication Form */
            .auth-section {
                padding: 60px 40px;
                text-align: center;
            }

            .auth-form {
                max-width: 400px;
                margin: 0 auto;
            }

            .auth-form h3 {
                font-size: 28px;
                font-weight: 600;
                margin-bottom: 32px;
                color: #ffffff;
            }

            .form-group {
                margin-bottom: 24px;
                text-align: left;
            }

            .form-group label {
                display: block;
                margin-bottom: 8px;
                color: rgba(255, 255, 255, 0.8);
                font-weight: 500;
            }

            .form-input {
                width: 100%;
                padding: 16px 20px;
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 12px;
                color: #ffffff;
                font-size: 16px;
                transition: all 0.3s ease;
                backdrop-filter: blur(10px);
            }

            .form-input:focus {
                outline: none;
                border-color: rgba(139, 92, 246, 0.5);
                background: rgba(255, 255, 255, 0.15);
                box-shadow: 0 0 20px rgba(139, 92, 246, 0.2);
            }

            .form-input::placeholder {
                color: rgba(255, 255, 255, 0.5);
            }

            .primary-button {
                width: 100%;
                padding: 16px 32px;
                background: linear-gradient(135deg, #8b5cf6, #a855f7);
                color: white;
                border: none;
                border-radius: 12px;
                font-weight: 600;
                font-size: 16px;
                cursor: pointer;
                transition: all 0.3s ease;
                box-shadow: 0 8px 30px rgba(139, 92, 246, 0.3);
            }

            .primary-button:hover {
                transform: translateY(-2px);
                box-shadow: 0 12px 40px rgba(139, 92, 246, 0.4);
            }

            /* Reports Content */
            .reports-content {
                padding: 40px;
            }

            .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin-bottom: 40px;
            }

            .stat-card {
                background: rgba(255, 255, 255, 0.05);
                padding: 24px;
                border-radius: 12px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                text-align: center;
                transition: all 0.3s ease;
            }

            .stat-card:hover {
                background: rgba(255, 255, 255, 0.08);
                transform: translateY(-2px);
            }

            .stat-number {
                font-size: 32px;
                font-weight: 700;
                margin-bottom: 8px;
                background: linear-gradient(135deg, #8b5cf6, #a855f7);
                background-clip: text;
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }

            .stat-label {
                color: rgba(255, 255, 255, 0.7);
                font-weight: 500;
            }

            .report-section {
                margin-bottom: 40px;
            }

            .section-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 24px;
                padding-bottom: 16px;
                border-bottom: 2px solid rgba(139, 92, 246, 0.3);
            }

            .section-title {
                font-size: 28px;
                font-weight: 700;
                color: #ffffff;
            }

            .refresh-button {
                padding: 8px 16px;
                background: rgba(255, 255, 255, 0.1);
                color: white;
                border: none;
                border-radius: 8px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.3s ease;
                backdrop-filter: blur(10px);
            }

            .refresh-button:hover {
                background: rgba(255, 255, 255, 0.2);
                transform: translateY(-1px);
            }

            .reports-grid {
                display: grid;
                gap: 20px;
            }

            .report-item {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 16px;
                padding: 24px;
                transition: all 0.3s ease;
                backdrop-filter: blur(10px);
            }

            .report-item:hover {
                background: rgba(255, 255, 255, 0.08);
                transform: translateY(-2px);
                box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
            }

            .report-item.status-approved {
                border-left: 4px solid #28a745;
                background: rgba(40, 167, 69, 0.1);
            }

            .report-item.status-denied {
                border-left: 4px solid #dc3545;
                background: rgba(220, 53, 69, 0.1);
            }

            .report-header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                margin-bottom: 16px;
            }

            .report-id {
                font-size: 14px;
                color: rgba(255, 255, 255, 0.6);
                font-family: 'Monaco', 'Menlo', monospace;
                background: rgba(255, 255, 255, 0.1);
                padding: 4px 8px;
                border-radius: 6px;
            }

            .report-status {
                padding: 4px 12px;
                border-radius: 20px;
                font-size: 12px;
                font-weight: 600;
                text-transform: uppercase;
            }

            .status-pending {
                background: rgba(255, 193, 7, 0.2);
                color: #ffc107;
                border: 1px solid rgba(255, 193, 7, 0.3);
            }

            .status-approved {
                background: rgba(40, 167, 69, 0.2);
                color: #28a745;
                border: 1px solid rgba(40, 167, 69, 0.3);
            }

            .status-denied {
                background: rgba(220, 53, 69, 0.2);
                color: #dc3545;
                border: 1px solid rgba(220, 53, 69, 0.3);
            }

            .report-content {
                margin-bottom: 16px;
            }

            .report-field {
                margin-bottom: 12px;
            }

            .field-label {
                font-weight: 600;
                color: rgba(255, 255, 255, 0.8);
                margin-bottom: 4px;
                font-size: 14px;
            }

            .field-value {
                color: #ffffff;
                word-break: break-word;
            }

            .field-value a {
                color: #8b5cf6;
                text-decoration: none;
                font-weight: 500;
                transition: color 0.3s ease;
            }

            .field-value a:hover {
                color: #a855f7;
                text-decoration: underline;
            }

            .report-meta {
                color: rgba(255, 255, 255, 0.6);
                font-size: 14px;
                margin-bottom: 16px;
                padding-top: 16px;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
            }

            .report-actions {
                display: flex;
                gap: 12px;
                flex-wrap: wrap;
            }

            .action-button {
                padding: 10px 20px;
                border: none;
                border-radius: 8px;
                font-weight: 600;
                font-size: 14px;
                cursor: pointer;
                transition: all 0.3s ease;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .btn-approve {
                background: linear-gradient(135deg, #28a745, #20c997);
                color: white;
                box-shadow: 0 4px 15px rgba(40, 167, 69, 0.3);
            }

            .btn-approve:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(40, 167, 69, 0.4);
            }

            .btn-deny {
                background: linear-gradient(135deg, #dc3545, #e83e8c);
                color: white;
                box-shadow: 0 4px 15px rgba(220, 53, 69, 0.3);
            }

            .btn-deny:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(220, 53, 69, 0.4);
            }

            .empty-state {
                text-align: center;
                padding: 60px 20px;
                color: rgba(255, 255, 255, 0.6);
            }

            .empty-state-icon {
                font-size: 48px;
                margin-bottom: 16px;
                opacity: 0.5;
            }

            .loading {
                text-align: center;
                padding: 40px;
                color: rgba(255, 255, 255, 0.7);
            }

            .loading::after {
                content: '';
                display: inline-block;
                width: 20px;
                height: 20px;
                border: 2px solid rgba(139, 92, 246, 0.3);
                border-radius: 50%;
                border-top-color: #8b5cf6;
                animation: spin 1s ease-in-out infinite;
                margin-left: 10px;
            }

            @keyframes spin {
                to { transform: rotate(360deg); }
            }

            /* Responsive Design */
            @media (max-width: 768px) {
                .nav {
                    padding: 16px 20px;
                }

                .container {
                    padding: 100px 15px 20px;
                }

                .header {
                    padding: 30px 20px;
                }

                .header h1 {
                    font-size: 36px;
                }

                .auth-section {
                    padding: 40px 20px;
                }

                .reports-content {
                    padding: 20px;
                }

                .stats-grid {
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                    gap: 15px;
                }

                .section-header {
                    flex-direction: column;
                    align-items: flex-start;
                    gap: 16px;
                }

                .report-header {
                    flex-direction: column;
                    align-items: flex-start;
                    gap: 12px;
                }

                .report-actions {
                    flex-direction: column;
                }

                .action-button {
                    justify-content: center;
                }
            }
        </style>
    </head>
    <body>
        <div class="wave-container">
            <div class="wave"></div>
            <div class="wave"></div>
        </div>

        <!-- Navigation -->
        <nav class="nav">
            <div class="nav-container">
                <div class="logo">ItsThatOneJack</div>
                <div class="nav-title">Report Management System</div>
            </div>
        </nav>

        <div class="container">
            <div class="main-card">
                <div class="header">
                    <h1>Report Management System</h1>
                    <p>Secure portal for managing BRP user reports.</p>
                </div>
                
                <div class="auth-section" id="auth-section">
                    <div class="auth-form">
                        <h3>Authentication Required</h3>
                        <form onsubmit="authenticate(event)">
                            <div class="form-group">
                                <label for="password">Access Password</label>
                                <input type="password" id="password" class="form-input" placeholder="Enter your password" required>
                            </div>
                            <button type="submit" class="primary-button">Access Dashboard</button>
                        </form>
                    </div>
                </div>
                
                <div id="reports-content" class="reports-content" style="display: none;">
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-number" id="pending-count">0</div>
                            <div class="stat-label">Pending Reports</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number" id="approved-count">0</div>
                            <div class="stat-label">Approved Reports</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number" id="denied-count">0</div>
                            <div class="stat-label">Denied Reports</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number" id="total-count">0</div>
                            <div class="stat-label">Total Reports</div>
                        </div>
                    </div>

                    <div class="report-section">
                        <div class="section-header">
                            <h2 class="section-title" id="pending-title">Pending Reports</h2>
                            <button class="refresh-button" onclick="loadReports()">Refresh</button>
                        </div>
                        <div id="pending-reports" class="reports-grid"></div>
                    </div>
                    
                    <div class="report-section">
                        <div class="section-header">
                            <h2 class="section-title" id="actioned-title">Actioned Reports</h2>
                        </div>
                        <div id="actioned-reports" class="reports-grid"></div>
                    </div>
                </div>
            </div>
        </div>
        
        <script>
            let isAuthenticated = false;

            async function authenticate(event) {
                event.preventDefault();
                const password = document.getElementById('password').value;
                
                try {
                    const response = await fetch('/auth', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password })
                    });
                    
                    if (response.ok) {
                        isAuthenticated = true;
                        document.getElementById('auth-section').style.display = 'none';
                        document.getElementById('reports-content').style.display = 'block';
                        loadReports();
                    } else {
                        // Add error animation
                        const input = document.getElementById('password');
                        input.style.borderColor = '#dc3545';
                        input.style.animation = 'shake 0.5s ease-in-out';
                        setTimeout(() => {
                            input.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                            input.style.animation = '';
                        }, 1000);
                        alert('❌ Invalid password');
                    }
                } catch (error) {
                    alert('Authentication error. Please try again.');
                }
            }
            
            async function loadReports() {
                if (!isAuthenticated) return;
                
                // Show loading state
                document.getElementById('pending-reports').innerHTML = '<div class="loading">Loading reports...</div>';
                document.getElementById('actioned-reports').innerHTML = '<div class="loading">Loading reports...</div>';
                
                try {
                    const response = await fetch('/api/reports');
                    const data = await response.json();
                    
                    // Update statistics
                    const approvedCount = data.actioned.filter(r => r.status === 'approved').length;
                    const deniedCount = data.actioned.filter(r => r.status === 'denied').length;
                    const totalCount = data.pending.length + data.actioned.length;
                    
                    document.getElementById('pending-count').textContent = data.pending.length;
                    document.getElementById('approved-count').textContent = approvedCount;
                    document.getElementById('denied-count').textContent = deniedCount;
                    document.getElementById('total-count').textContent = totalCount;
                    
                    displayReports(data.pending, 'pending-reports', true);
                    displayReports(data.actioned, 'actioned-reports', false);
                } catch (error) {
                    console.error('Error loading reports:', error);
                    document.getElementById('pending-reports').innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><p>Error loading reports. Please refresh.</p></div>';
                    document.getElementById('actioned-reports').innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><p>Error loading reports. Please refresh.</p></div>';
                }
            }
            
            function displayReports(reports, containerId, showActions) {
                const container = document.getElementById(containerId);
                
                if (reports.length === 0) {
                    const emptyIcon = showActions ? '📭' : '📋';
                    const emptyMessage = showActions ? 'No pending reports' : 'No actioned reports yet';
                    container.innerHTML = \`<div class="empty-state"><div class="empty-state-icon">\${emptyIcon}</div><p>\${emptyMessage}</p></div>\`;
                    return;
                }
                
                container.innerHTML = reports.map(report => {
                    const targetLink = \`https://rugplay.com/user/\${report.target}\`;
                    const reporterLink = \`https://rugplay.com/user/\${report.reporter}\`;
                    const statusClass = report.status ? \`status-\${report.status}\` : 'status-pending';
                    const statusText = report.status || 'pending';
                    
                    return \`
                        <div class="report-item \${report.status ? 'status-' + report.status : ''}">
                            <div class="report-header">
                                <div class="report-id">ID: \${report.id}</div>
                                <div class="report-status \${statusClass}">\${statusText}</div>
                            </div>
                            
                            <div class="report-content">
                                <div class="report-field">
                                    <div class="field-label">Target User:</div>
                                    <div class="field-value"><a href="\${targetLink}" target="_blank">\${report.target}</a></div>
                                </div>
                                
                                <div class="report-field">
                                    <div class="field-label">Reporter:</div>
                                    <div class="field-value"><a href="\${reporterLink}" target="_blank">\${report.reporter}</a></div>
                                </div>
                                
                                <div class="report-field">
                                    <div class="field-label">Reason:</div>
                                    <div class="field-value">\${report.reason}</div>
                                </div>
                                
                                <div class="report-field">
                                    <div class="field-label">Context:</div>
                                    <div class="field-value">\${report.context}</div>
                                </div>
                            </div>
                            
                            <div class="report-meta">
                                Submitted: \${new Date(report.timestamp).toLocaleString()}
                                \${report.actionedAt ? \`<br>Actioned: \${new Date(report.actionedAt).toLocaleString()}\` : ''}
                            </div>
                            
                            \${showActions ? \`
                                <div class="report-actions">
                                    <button class="action-button btn-approve" onclick="actionReport('\${report.id}', 'approved')">
                                        ✅ Approve & Flag
                                    </button>
                                    <button class="action-button btn-deny" onclick="actionReport('\${report.id}', 'denied')">
                                        ❌ Deny Report
                                    </button>
                                </div>
                            \` : ''}
                        </div>
                    \`;
                }).join('');
            }
            
            async function actionReport(reportId, action) {
                const actionText = action === 'approved' ? 'approve' : 'deny';
                
                if (!confirm(\`Are you sure you want to \${actionText} report \${reportId}?\`)) {
                    return;
                }
                
                try {
                    const response = await fetch('/api/action', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reportId, action })
                    });
                    
                    if (response.ok) {
                        // Reload reports after a brief delay
                        setTimeout(() => {
                            loadReports();
                        }, 1000);
                    } else {
                        const errorData = await response.json();
                        alert(\`Error: \${errorData.error || 'Unknown error occurred'}\`);
                    }
                } catch (error) {
                    console.error('Action error:', error);
                    alert('Error processing action. Please try again.');
                }
            }
            
            // Auto-refresh every 30 seconds
            setInterval(() => {
                if (isAuthenticated && document.getElementById('reports-content').style.display !== 'none') {
                    loadReports();
                }
            }, 30000);
            
            // Add shake animation for form errors
            const style = document.createElement('style');
            style.textContent = \`
                @keyframes shake {
                    0%, 100% { transform: translateX(0); }
                    10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
                    20%, 40%, 60%, 80% { transform: translateX(5px); }
                }
            \`;
            document.head.appendChild(style);
        </script>
    </body>
    </html>
    `);
});

async function ValidatePassword(password) {
    const loginHashes = process.env.LOGIN_HASHES;
    
    if (!loginHashes) {
        console.warn('LOGIN_HASHES environment variable not set!');
        return false;
    }
    const hashes = loginHashes.split(';').map(hash => hash.trim()).filter(hash => hash.length > 0);
    if (hashes.length === 0) {
        console.warn('No valid hashes found in LOGIN_HASHES!');
        return false;
    }
    for (const hash of hashes) {
        try {
            const isMatch = await bcrypt.compare(password, hash);
            if (isMatch) {
                return true;
            }
        } catch (error) {
            console.error(`Error comparing password with hash: ${error.message}`);
        }
    }
    
    return false;
}


// POST /auth - Authenticate for reports view
app.post('/auth', async (req, res) => {
    const { password } = req.body;
    
    if (!password) {
        return res.status(400).json({ error: 'Password required!' });
    }
    
    try {
        const isValid = await ValidatePassword(password);
        
        if (isValid) {
            res.json({ success: true });
        } else {
            res.status(401).json({ error: 'Invalid password!' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Authentication error!' });
    }
});

// GET /api/reports - Get reports data (authenticated)
app.get('/api/reports', (req, res) => {
    res.json({
        pending: reports,
        actioned: actionedReports
    });
});

// POST /api/action - Action a report (authenticated)
app.post('/api/action', async (req, res) => {
    const { reportId, action } = req.body;
    
    if (!reportId || !action || !['approved', 'denied'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action or report ID!' });
    }
    
    const reportIndex = reports.findIndex(r => r.id === reportId);
    
    if (reportIndex === -1) {
        return res.status(404).json({ error: 'Report not found!' });
    }
    
    const report = reports[reportIndex];
    report.status = action;
    report.actionedAt = new Date().toISOString();
    
    // Move to actioned reports
    actionedReports.push(report);
    reports.splice(reportIndex, 1);
    
    // If denied, add to GitHub ban list
    if (action === 'approved') {
        let Target = actionedReports.slice(-1)[0].target;
        let Reporter = actionedReports.slice(-1)[0].reporter;
        let BodyText = actionedReports.slice(-1)[0].body;
        FireWebhook(`**Approved**\n\n**Body Text: **"\`${BodyText}\`"\n\n**\`Target  : \`**[${Target}](<https://rugplay.com/user/${Target}>)\n**\`Reporter: \`**[${Reporter}](<https://rugplay.com/user/${Reporter}>)`,CONFIG.ACTIONS_WEBHOOK);
        await addToGitHubBanList(report);
    } else {
        let Target = actionedReports.slice(-1)[0].target;
        let Reporter = actionedReports.slice(-1)[0].reporter;
        let BodyText = actionedReports.slice(-1)[0].body;
        FireWebhook(`**Approved**\n\n**Body Text: **"\`${BodyText}\`"\n\n**\`Target  : \`**[${Target}](<https://rugplay.com/user/${Target}>)\n**\`Reporter: \`**[${Reporter}](<https://rugplay.com/user/${Reporter}>)`,CONFIG.ACTIONS_WEBHOOK);
    }
    
    res.json({ success: true, message: `Report ${action} successfull!` });
});

// Redirect all other routes to /reports
app.get('*', (req, res) => {
    res.status(301).redirect('/reports');
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Report server running on port ${PORT}`);
    console.log(`📊 Reports available at: http://localhost:${PORT}/reports`);
    console.log(`🔧 GitHub integration: ${CONFIG.GITHUB_ENABLED ? 'ENABLED' : 'DISABLED'}`);
});

module.exports = app;
