// ===================================================
// Nail Arts Blog - Backend API
// Firestore-only storage (images as base64 data URIs)
// Deploy: Vercel
// ===================================================
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

// ---------- Firebase Admin Init ----------
if (!admin.apps.length) {
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
  privateKey = privateKey.replace(/\\n/g, '\n').replace(/^"|"$/g, '');

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
  });
}

const db = admin.firestore();

// ---------- App Setup ----------
const app = express();
app.use(cors());

// Base64 images JSON me aati hain, isliye limit barha diya
// (Firestore doc limit 1MB hai, lekin hum 850KB pe cap karte hain)
app.use(express.json({ limit: '3mb' }));

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

// Validate base64 image (data URI) size
// Firestore limit 1MB = 1,048,576 bytes
// Safety cap: 850KB base64 (~600KB raw image after base64 inflation)
const MAX_IMAGE_BASE64_BYTES = 850 * 1024;

function validateImageField(imageUrl) {
  if (!imageUrl) return { ok: true, value: '' };

  if (typeof imageUrl !== 'string') {
    return { ok: false, error: 'Invalid image data' };
  }

  // External URL allowed (legacy posts)
  if (!imageUrl.startsWith('data:')) {
    if (!/^https?:\/\//i.test(imageUrl)) {
      return { ok: false, error: 'Image must be a data URI or valid URL' };
    }
    return { ok: true, value: imageUrl };
  }

  // Base64 data URI
  if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(imageUrl)) {
    return { ok: false, error: 'Only JPEG, PNG, WEBP or GIF images allowed' };
  }

  // Approximate byte size (base64 chars are ASCII → 1 byte each)
  const approxBytes = imageUrl.length;
  if (approxBytes > MAX_IMAGE_BASE64_BYTES) {
    return {
      ok: false,
      error: `Image too large (${Math.round(
        approxBytes / 1024
      )}KB). Max 850KB — please compress to under 600KB raw.`,
    };
  }

  return { ok: true, value: imageUrl };
}

// ===================================================
// AUTH ROUTES
// ===================================================

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
// POST ROUTES
// ===================================================

// GET /api/posts
// Returns list — content truncated to 500 chars (excerpt only) to save bandwidth.
// imageUrl (base64) is returned in full so homepage cards can display images.
app.get('/api/posts', async (req, res) => {
  try {
    const snap = await db.collection('posts').get();
    let posts = snap.docs.map((d) => {
      const data = d.data();
      const plainContent = String(data.content || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      return {
        id: d.id,
        title: data.title || '',
        slug: data.slug || '',
        // Truncated preview only for list — full content comes from single-post route
        content:
          plainContent.length > 500
            ? plainContent.slice(0, 500) + '…'
            : plainContent,
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
// Body: { title, content, imageUrl, category, tags }
// imageUrl may be a base64 data URI or external URL
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { title, content, imageUrl, category, tags } = req.body || {};
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    const imgCheck = validateImageField(imageUrl);
    if (!imgCheck.ok) return res.status(400).json({ error: imgCheck.error });

    const slug = slugify(title) + '-' + Date.now().toString(36);

    const ref = await db.collection('posts').add({
      title,
      slug,
      content,
      imageUrl: imgCheck.value,
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

    const imgCheck = validateImageField(imageUrl);
    if (!imgCheck.ok) return res.status(400).json({ error: imgCheck.error });

    const update = {
      content: content || '',
      imageUrl: imgCheck.value,
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
// Image is stored inside the document (base64), so no separate cleanup needed
app.delete('/api/posts/:id', authMiddleware, async (req, res) => {
  try {
    await db.collection('posts').doc(req.params.id).delete();
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
    storage: 'firestore-base64',
  })
);

// Local dev
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
}

module.exports = app;
