// server.js - Complete Backend API for TeleBot Creator
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

// ==================== FIREBASE INIT ====================
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://your-project-default-rtdb.firebaseio.com"
  });

  console.log('🔥 Firebase initialized successfully');
} catch (error) {
  console.error('❌ Firebase initialization error:', error);
  process.exit(1);
}

const db = admin.database();

// ==================== CONFIGURATION ====================
const BOT_USERNAME = process.env.BOT_USERNAME || 'MineSimBot';
const REFERRAL_BONUS = 1000;
const PORT = process.env.PORT || 3000;

// ==================== EXPRESS SERVER ====================
const app = express();

app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// ==================== HELPER FUNCTIONS ====================
async function getUserData(userId) {
  const userRef = db.ref(`users/${userId}`);
  const snapshot = await userRef.once('value');
  return snapshot.val();
}

async function updateUserData(userId, data) {
  const userRef = db.ref(`users/${userId}`);
  await userRef.update(data);
}

async function processReferral(referralCode, newUserId, username) {
  try {
    const usersRef = db.ref('users');
    const snapshot = await usersRef.orderByChild('referralCode').equalTo(referralCode).once('value');
    
    if (!snapshot.exists()) {
      return null;
    }

    let referrerId = null;
    let referrerData = null;
    snapshot.forEach((childSnapshot) => {
      referrerId = childSnapshot.key;
      referrerData = childSnapshot.val();
    });

    if (!referrerId || (referrerData.referredUsers && referrerData.referredUsers[newUserId])) {
      return null;
    }

    const newReferralCount = (referrerData.referralCount || 0) + 1;
    const newBalance = (referrerData.balance || 0) + REFERRAL_BONUS;

    await updateUserData(referrerId, {
      referralCount: newReferralCount,
      balance: newBalance,
      lastSeen: Date.now(),
      [`referredUsers/${newUserId}`]: {
        userId: newUserId,
        timestamp: Date.now(),
        username: username || 'Anonymous',
        bonusEarned: REFERRAL_BONUS
      }
    });

    return { referrerId, newReferralCount, newBalance };
  } catch (error) {
    console.error('Referral processing error:', error);
    return null;
  }
}

// ==================== API ENDPOINTS ====================

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    timestamp: Date.now(),
    bot: BOT_USERNAME,
    version: '1.0.0'
  });
});

// 1. Register/Get User
app.post('/api/user/register', async (req, res) => {
  try {
    const { userId, telegramId, username, firstName, lastName } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();

    const now = Date.now();

    if (userData) {
      await userRef.update({
        lastSeen: now,
        telegramId: telegramId || userData.telegramId,
        username: username || userData.username,
        firstName: firstName || userData.firstName,
        lastName: lastName || userData.lastName
      });
      
      return res.status(200).json({
        success: true,
        isNewUser: false,
        user: {
          userId,
          balance: userData.balance || 0,
          totalMined: userData.totalMined || 0,
          referralCount: userData.referralCount || 0,
          referralCode: userData.referralCode,
          registeredAt: userData.registeredAt
        }
      });
    } else {
      const referralCode = `ref_${userId}`;
      const newUser = {
        userId,
        telegramId: telegramId || '',
        username: username || '',
        firstName: firstName || '',
        lastName: lastName || '',
        balance: 0,
        totalMined: 0,
        referralCount: 0,
        referralCode: referralCode,
        registeredAt: now,
        lastSeen: now,
        isActive: true,
        miningHistory: {},
        referredUsers: {}
      };

      await userRef.set(newUser);

      return res.status(201).json({
        success: true,
        isNewUser: true,
        user: newUser
      });
    }
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Mining Action
app.post('/api/mine', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();

    if (!userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Mining: 1-4 coins with 10% chance of bonus (+5)
    const baseMined = Math.floor(Math.random() * 4) + 1;
    const bonusChance = Math.random() < 0.1;
    const minedAmount = bonusChance ? baseMined + 5 : baseMined;
    
    const newBalance = (userData.balance || 0) + minedAmount;
    const newTotalMined = (userData.totalMined || 0) + minedAmount;

    await userRef.update({
      balance: newBalance,
      totalMined: newTotalMined,
      lastMined: Date.now(),
      lastSeen: Date.now(),
      [`miningHistory/${Date.now()}`]: {
        amount: minedAmount,
        timestamp: Date.now(),
        balance: newBalance,
        bonus: bonusChance
      }
    });

    res.json({
      success: true,
      mined: minedAmount,
      bonus: bonusChance,
      newBalance: newBalance,
      totalMined: newTotalMined,
      message: bonusChance ? '🎉 Bonus! +5 extra coins!' : 'Mining successful!'
    });
  } catch (error) {
    console.error('Mining error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Process Referral
app.post('/api/referral/process', async (req, res) => {
  try {
    const { referralCode, newUserId, username } = req.body;
    
    if (!referralCode || !newUserId) {
      return res.status(400).json({ error: 'referralCode and newUserId are required' });
    }

    const result = await processReferral(referralCode, newUserId, username);
    
    if (!result) {
      return res.status(404).json({ error: 'Invalid referral code or already referred' });
    }

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Referral processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Get Referral Stats
app.get('/api/referral/stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userData = await getUserData(userId);

    if (!userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const referredUsers = userData.referredUsers || {};
    const referralCount = Object.keys(referredUsers).length;
    const totalEarned = referralCount * 1000;

    const recentReferrals = Object.entries(referredUsers)
      .sort((a, b) => b[1].timestamp - a[1].timestamp)
      .slice(0, 10)
      .map(([id, data]) => ({
        userId: id,
        username: data.username || 'Anonymous',
        timestamp: data.timestamp,
        bonusEarned: data.bonusEarned || 1000
      }));

    res.json({
      success: true,
      referralCount: referralCount,
      referralCode: userData.referralCode,
      referralLink: `https://t.me/${BOT_USERNAME}?start=${userData.referralCode}`,
      totalEarnedFromReferrals: totalEarned,
      recentReferrals: recentReferrals,
      bonusPerReferral: 1000,
      nextMilestone: {
        current: referralCount,
        next: Math.floor(referralCount / 5) * 5 + 5,
        bonus: Math.floor(referralCount / 5 + 1) * 500
      }
    });
  } catch (error) {
    console.error('Referral stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Get Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const usersRef = db.ref('users');
    const snapshot = await usersRef.orderByChild('balance').limitToLast(100).once('value');
    
    const leaderboard = [];
    snapshot.forEach((childSnapshot) => {
      const user = childSnapshot.val();
      leaderboard.push({
        userId: childSnapshot.key,
        username: user.username || user.firstName || 'Anonymous',
        balance: user.balance || 0,
        totalMined: user.totalMined || 0,
        referralCount: user.referralCount || 0
      });
    });

    leaderboard.reverse();

    res.json({
      success: true,
      leaderboard: leaderboard
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 6. Get Global Stats
app.get('/api/stats/global', async (req, res) => {
  try {
    const usersRef = db.ref('users');
    const snapshot = await usersRef.once('value');
    
    let totalUsers = 0;
    let totalCoinsMined = 0;
    let totalReferrals = 0;

    snapshot.forEach((childSnapshot) => {
      const user = childSnapshot.val();
      totalUsers++;
      totalCoinsMined += user.totalMined || 0;
      totalReferrals += user.referralCount || 0;
    });

    res.json({
      success: true,
      stats: {
        totalUsers,
        totalCoinsMined,
        totalReferrals,
        averageBalance: totalUsers > 0 ? Math.round(totalCoinsMined / totalUsers) : 0,
        totalReferralBonus: totalReferrals * 1000
      }
    });
  } catch (error) {
    console.error('Global stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 7. Get User Data
app.get('/api/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userData = await getUserData(userId);

    if (!userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        userId: userId,
        balance: userData.balance || 0,
        totalMined: userData.totalMined || 0,
        referralCount: userData.referralCount || 0,
        referralCode: userData.referralCode,
        registeredAt: userData.registeredAt,
        lastSeen: userData.lastSeen
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== START SERVER ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`🤖 Bot: @${BOT_USERNAME}`);
  console.log(`📊 Firebase: Connected`);
  console.log(`✅ API Ready!\n`);
});

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
