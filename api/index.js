// ===================================================
// Nail Arts Blog - Backend API
// Storage: Firebase Storage (images) + Firestore (data)
// Deploy: Vercel
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

// Admin auth middleware
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

// Firebase Storage se image delete karo
const deleteImageFromStorage = async (imageUrl) => {
  try {
    if (!imageUrl) return;
    // Only delete if it's a Firebase Storage URL
    if (!imageUrl.includes('firebasestorage.googleapis.com')) return;

    // Extract file path from URL
    // URL format: https://firebasestorage.googleapis.com/v0/b/BUCKET/o/PATH?alt=media&token=...
    const match = imageUrl.match(/\/o\/([^?]+)/);
    if (!match) return;

    const filePath = decodeURIComponent(match[1]);
    await bucket.file(filePath).delete();
    console.log('Deleted from Storage:', filePath);
  } catch (e) {
    // Ignore 404 (already deleted) — log others
    if (!e.message.includes('No such object')) {
      console.log('Image delete failed:', e.message);
    }
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

// GET /api/categories (public)
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

// POST /api/categories (admin only)
app.post('/api/categories', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const slug = slugify(name);

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

// DELETE /api/categories/:id (admin only)
app.delete('/api/categories/:id', authMiddleware, async (req, res) => {
  try {
    await db.collection('categories').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===================================================
// IMAGE UPLOAD (Firebase Storage)
// ===================================================

// POST /api/upload  (admin only) — multipart form-data, field: "image"
app.post(
  '/api/upload',
  authMiddleware,
  upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Validate image type
      const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowed.includes(req.file.mimetype)) {
        return res.status(400).json({
          error: 'Only JPEG, PNG, WEBP or GIF images allowed',
        });
      }

      // Build unique filename
      const ext = (req.file.originalname.split('.').pop() || 'jpg')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      const filename = `posts/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;

      const file = bucket.file(filename);

      // Upload to Firebase Storage
      await file.save(req.file.buffer, {
        metadata: {
          contentType: req.file.mimetype,
          cacheControl: 'public, max-age=31536000, immutable',
        },
        resumable: false,
        public: true, // make file publicly readable via URL
      });

      // Make public (in case public:true in save() isn't honored on some setups)
      try {
        await file.makePublic();
      } catch (e) {
        // Ignore if already public / IAM blocks it — we'll use signed URL fallback
      }

      // Build the public download URL
      const encodedPath = encodeURIComponent(filename);
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media`;

      res.json({ url, filename });
    } catch (e) {
      console.error('Upload error:', e);
      res.status(500).json({ error: e.message || 'Upload failed' });
    }
  }
);

// ===================================================
// POST ROUTES
// ===================================================

// GET /api/posts
// List view — content truncated to 500 chars for faster loading
app.get('/api/posts', async (req, res) => {
  try {
    const snap = await db.collection('posts').get();
    let posts = snap.docs.map((d) => {
      const data = d.data();
      const plain = String(data.content || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        id: d.id,
        title: data.title || '',
        slug: data.slug || '',
        content: plain.length > 500 ? plain.slice(0, 500) + '…' : plain,
        imageUrl: data.imageUrl || '',
        category: data.category || '',
        tags: Array.isArray(data.tags) ? data.tags : [],
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    });

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

// GET /api/posts/:slug (full single post)
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

// POST /api/posts (admin only)
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

// PUT /api/posts/:id (admin only)
app.put('/api/posts/:id', authMiddleware, async (req, res) => {
  try {
    const { title, content, imageUrl, category, tags } = req.body || {};
    const docRef = db.collection('posts').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Post not found' });

    const oldImage = doc.data().imageUrl || '';
    const newImage = imageUrl || '';

    // If image changed, delete old one from Storage
    if (oldImage && newImage && oldImage !== newImage) {
      await deleteImageFromStorage(oldImage);
    }
    // If image removed entirely
    if (oldImage && !newImage) {
      await deleteImageFromStorage(oldImage);
    }

    const update = {
      content: content || '',
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

// DELETE /api/posts/:id (admin only)
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
  res.json({
    status: 'ok',
    message: 'Nail Arts API is running 🚀',
    storage: 'firebase-storage',
  })
);

// Local dev
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
}

module.exports = app;
