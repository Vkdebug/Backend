const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// --- MULTER CONFIGURATION FOR FILE UPLOADS ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// --- DATABASE CONNECTION ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) return console.error('❌ MySQL Error:', err.message);
    console.log('🚀 MySQL Database connected successfully!');
});

// ==========================================
// 1. LIVE TRACKING & STATS ENGINE
// ==========================================
app.get('/api/users/stats', (req, res) => {
    db.query("SELECT COUNT(*) as total FROM users WHERE role = 'student'", (err, totalRes) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.query("SELECT COUNT(*) as live FROM users WHERE role = 'student' AND is_taking_test = 1", (err, liveRes) => {
            if (err) return res.status(500).json({ error: err.message });
            
            res.json({
                totalStudents: totalRes[0].total,
                liveStudents: liveRes[0].live
            });
        });
    });
});

app.post('/api/users/live-status', (req, res) => {
    const { userId, isTakingTest } = req.body;
    db.query("UPDATE users SET is_taking_test = ? WHERE id = ?", [isTakingTest ? 1 : 0, userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ==========================================
// 2. SUBJECTS & MATERIALS
// ==========================================
app.get('/api/subjects', (req, res) => {
    db.query("SELECT DISTINCT assigned_subject FROM users WHERE role = 'teacher' AND assigned_subject != 'All'", (err, results) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json(results.map(row => row.assigned_subject)); 
    });
});

app.get('/api/materials', (req, res) => {
    db.query("SELECT * FROM materials ORDER BY uploaded_at DESC", (err, results) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json(results);
    });
});

app.post('/api/materials/add', upload.single('file'), (req, res) => {
    const { title, category, subject, time_limit_minutes, difficulty_level, max_attempts } = req.body;
    const file_url = req.file ? `/uploads/${req.file.filename}` : ''; 
    
    // Default values if undefined
    const timeLimit = time_limit_minutes || 30;
    const diffLevel = difficulty_level || 'Mixed';
    const attempts = max_attempts || 1;

    db.query("INSERT INTO materials (title, category, subject, file_url, time_limit_minutes, difficulty_level, max_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)", 
    [title, category, subject, file_url, timeLimit, diffLevel, attempts], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ message: "Upload successful!" });
    });
});

app.delete('/api/materials/:id', (req, res) => {
    db.query("DELETE FROM materials WHERE id = ?", [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Deleted successfully!" });
    });
});

// ==========================================
// 3. SECURE TEST SUBMISSION & ATTEMPT LOCKOUT
// ==========================================
app.get('/api/scores', (req, res) => {
    db.query("SELECT * FROM test_scores ORDER BY test_date DESC", (err, results) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json(results);
    });
});

app.post('/api/scores/add', (req, res) => {
    const { test_title, subject, score, total_marks, student_id, student_name, roll_number } = req.body;
    
    // Check how many times this student has taken this test
    db.query("SELECT COUNT(*) as attemptCount FROM test_scores WHERE student_id = ? AND test_title = ?", 
    [student_id, test_title], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const currentAttempt = results[0].attemptCount + 1;

        // Fetch max_attempts allowed for this specific test
        db.query("SELECT max_attempts FROM materials WHERE title = ? AND category = 'Mock Test' LIMIT 1", [test_title], (err2, materialsResults) => {
            if (err2) return res.status(500).json({ error: err2.message });
            
            const maxAllowed = materialsResults.length > 0 ? materialsResults[0].max_attempts : 1;

            // Strict Server-Side Lockout
            if (currentAttempt > maxAllowed) {
                return res.status(403).json({ error: "Maximum attempts reached for this test. Submission rejected." });
            }

            // Save the score if attempt is valid
            db.query("INSERT INTO test_scores (test_title, subject, score, total_marks, student_id, student_name, roll_number, attempt_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", 
            [test_title, subject, score, total_marks, student_id, student_name, roll_number, currentAttempt], (err3) => {
                if (err3) return res.status(500).json({ error: err3.message });
                
                // Automatically set user back to NOT live upon successful submission
                db.query("UPDATE users SET is_taking_test = 0 WHERE id = ?", [student_id]);
                
                res.status(201).json({ message: "Score saved successfully!" });
            });
        });
    });
});

// Delete a specific student score
app.delete('/api/scores/:id', (req, res) => {
    db.query("DELETE FROM test_scores WHERE id = ?", [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Score deleted successfully!" });
    });
});

// ==========================================
// 4. AUTHENTICATION & OTP VERIFICATION
// ==========================================
const transporter = nodemailer.createTransport({
    service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

app.post('/api/auth/register', async (req, res) => {
    const { name, email, password, role, assigned_subject, mobile_number, roll_number } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const subj = role === 'teacher' ? assigned_subject : 'All'; 
        
        db.query("INSERT INTO users (name, email, password, role, assigned_subject, mobile_number, roll_number) VALUES (?, ?, ?, ?, ?, ?, ?)", 
        [name, email, hashedPassword, role, subj, mobile_number || null, roll_number || null], (err) => {
            if (err) return res.status(400).json({ error: "Email already exists." });
            res.status(201).json({ message: "Registration successful!" });
        });
    } catch (error) { res.status(500).json({ error: "Server error" }); }
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    db.query("SELECT * FROM users WHERE email = ?", [email], async (err, results) => {
        if (err || results.length === 0) return res.status(400).json({ error: "User not found." });
        
        const user = results[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: "Incorrect password." });

        const userData = { 
            id: user.id, 
            name: user.name, 
            role: user.role, 
            assigned_subject: user.assigned_subject,
            mobile_number: user.mobile_number,
            roll_number: user.roll_number
        };

        if (user.role === 'student') return res.json({ message: "Login successful", user: userData });

        const otp = Math.floor(100000 + Math.random() * 900000).toString(); 
        db.query("UPDATE users SET otp = ? WHERE id = ?", [otp, user.id], (updateErr) => {
            if (updateErr) return res.status(500).json({ error: "Could not generate OTP." });
            transporter.sendMail({ from: process.env.EMAIL_USER, to: user.email, subject: "Your Teacher Login OTP", text: `Your OTP: ${otp}` });
            res.json({ requiresOtp: true, email: user.email, message: "OTP sent!" });
        });
    });
});

app.post('/api/auth/verify-otp', (req, res) => {
    const { email, otp } = req.body;
    db.query("SELECT * FROM users WHERE email = ? AND otp = ?", [email, otp], (err, results) => {
        if (err || results.length === 0) return res.status(400).json({ error: "Invalid OTP." });
        const user = results[0];
        db.query("UPDATE users SET otp = NULL WHERE id = ?", [user.id]);
        res.json({ message: "Login successful", user: { id: user.id, name: user.name, role: user.role, assigned_subject: user.assigned_subject } });
    });
});

// ==========================================
// VERCEL DEPLOYMENT CONFIGURATION (FIX)
// ==========================================

// Add a default base route so Vercel doesn't return a 404 error on the home URL
app.get('/', (req, res) => {
    res.send("🚀 EduPlatform Backend is successfully running on Vercel!");
});

// Export the application object for Vercel's serverless handler
module.exports = app;

// Only listen to a specific local port if we are NOT running on production (Vercel)
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`🚀 Server running locally on http://localhost:${PORT}`));
}