// ===================================================
// Nail Arts Blog - Backend API
// All routes in one file, deploy on Vercel
// ===================================================
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const admin = require('firebase-admin');

// ---------- Firebase Admin Init ----------
if (!admin.apps.length) {
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
  // Vercel env me "\n" text milta hai, usko real newline me convert karo
  privateKey = privateKey.replace(/\\n/g, '\n').replace(/^"|"$/g, '');

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

// ---------- App Setup ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ---------- Helpers ----------
const slugify = (text) =>
  text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// Admin auth middleware (JWT verify)
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - token missing' });
  }
  try {
    jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Firebase Storage se image delete karo (jab post delete/update ho)
const deleteImageFromStorage = async (imageUrl) => {
  try {
    if (!imageUrl || !imageUrl.includes('firebasestorage.googleapis.com')) return;
    const match = imageUrl.match(/\/o\/([^?]+)/);
    if (!match) return;
    const filename = decodeURIComponent(match[1]);
    await bucket.file(filename).delete();
  } catch (e) {
    console.log('Image delete failed:', e.message);
  }
};

// ===================================================
// AUTH ROUTES
// ===================================================

// POST /api/login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });
    return res.json({ token });
  }
  return res.status(401).json({ error: 'Invalid username or password' });
});

// ===================================================
// CATEGORY ROUTES
// ===================================================

// GET /api/categories  (public - frontend slider ke liye)
app.get('/api/categories', async (req, res) => {
  try {
    const snap = await db.collection('categories').get();
    const cats = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cats.sort(
      (a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0)
    );
    res.json(cats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/categories  (admin only)
app.post('/api/categories', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const slug = slugify(name);

    // Duplicate check
    const existing = await db
      .collection('categories')
      .where('slug', '==', slug)
      .limit(1)
      .get();
    if (!existing.empty) {
      return res.status(400).json({ error: 'Category already exists' });
    }

    const ref = await db.collection('categories').add({
      name,
      slug,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ id: ref.id, name, slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/categories/:id  (admin only)
app.delete('/api/categories/:id', authMiddleware, async (req, res) => {
  try {
    await db.collection('categories').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===================================================
// IMAGE UPLOAD
// ===================================================

// POST /api/upload  (admin only) — multipart form-data, field name: "image"
app.post(
  '/api/upload',
  authMiddleware,
  upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
      const filename = `posts/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;
      const file = bucket.file(filename);

      await file.save(req.file.buffer, {
        metadata: { contentType: req.file.mimetype },
        resumable: false,
      });

      const url = `https://firebasestorage.googleapis.com/v0/b/${
        bucket.name
      }/o/${encodeURIComponent(filename)}?alt=media`;

      res.json({ url, filename });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ===================================================
// POST ROUTES
// ===================================================

// GET /api/posts  (?category=slug optional)
app.get('/api/posts', async (req, res) => {
  try {
    const snap = await db.collection('posts').get();
    let posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    posts.sort(
      (a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0)
    );

    if (req.query.category) {
      posts = posts.filter((p) => p.category === req.query.category);
    }

    res.json(posts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/posts/:slug  (single post)
app.get('/api/posts/:slug', async (req, res) => {
  try {
    const snap = await db
      .collection('posts')
      .where('slug', '==', req.params.slug)
      .limit(1)
      .get();

    if (snap.empty) return res.status(404).json({ error: 'Post not found' });

    const doc = snap.docs[0];
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/posts  (admin only)
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { title, content, imageUrl, category, tags } = req.body || {};
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    const slug = slugify(title) + '-' + Date.now().toString(36);

    const ref = await db.collection('posts').add({
      title,
      slug,
      content,
      imageUrl: imageUrl || '',
      category: category || '',
      tags: Array.isArray(tags) ? tags : [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ id: ref.id, slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/posts/:id  (admin only)
app.put('/api/posts/:id', authMiddleware, async (req, res) => {
  try {
    const { title, content, imageUrl, category, tags } = req.body || {};
    const docRef = db.collection('posts').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Post not found' });

    const oldImage = doc.data().imageUrl || '';
    const newImage = imageUrl || '';

    // Agar image change hui to purani delete karo
    if (oldImage && newImage && oldImage !== newImage) {
      await deleteImageFromStorage(oldImage);
    }

    const update = {
      content,
      imageUrl: newImage,
      category: category || '',
      tags: Array.isArray(tags) ? tags : [],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (title) update.title = title;

    await docRef.update(update);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/posts/:id  (admin only)
app.delete('/api/posts/:id', authMiddleware, async (req, res) => {
  try {
    const docRef = db.collection('posts').doc(req.params.id);
    const doc = await docRef.get();
    if (doc.exists) {
      await deleteImageFromStorage(doc.data().imageUrl);
    }
    await docRef.delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===================================================
// HEALTH CHECK
// ===================================================
app.get('/api', (req, res) =>
  res.json({ status: 'ok', message: 'Nail Arts API is running 🚀' })
);

// Local dev ke liye listen (Vercel pe automatically handle hota hai)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
}

module.exports = app;
