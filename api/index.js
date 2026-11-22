// ===================================================
// Nail Arts Blog - Backend API
// All routes in one file, deploy on Vercel
// Image upload: Catbox.moe (free, no billing)
// ===================================================
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const admin = require('firebase-admin');

// ---------- Firebase Admin Init (Firestore only) ----------
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
  });
}

const db = admin.firestore();

// ---------- App Setup ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB (Catbox supports more, but keep safe)
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

// Browser-like User-Agent to avoid 412 from Catbox
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------- Catbox Upload Helper ----------
async function uploadToCatbox(buffer, mimetype, originalname) {
  const formData = new FormData();
  formData.append('reqtype', 'fileupload');
  if (process.env.CATBOX_USERHASH) {
    formData.append('userhash', process.env.CATBOX_USERHASH);
  }
  formData.append(
    'fileToUpload',
    new Blob([buffer], { type: mimetype || 'image/jpeg' }),
    originalname || 'image.jpg'
  );

  const response = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    body: formData,
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `Catbox upload failed with status ${response.status}${
        errorBody ? ` — ${errorBody.substring(0, 200)}` : ''
      }`
    );
  }

  const result = (await response.text()).trim();

  // Success response ek seedha URL hota hai
  if (!/^https?:\/\//i.test(result)) {
    throw new Error(
      `Catbox returned invalid response: ${result.substring(0, 200)}`
    );
  }

  return result;
}

// ---------- Catbox Delete Helper ----------
async function deleteFromCatbox(imageUrl) {
  try {
    if (!imageUrl || !/catbox\.moe/i.test(imageUrl)) return;
    if (!process.env.CATBOX_USERHASH) return;

    const filename = imageUrl.split('/').pop();
    if (!filename) return;

    const formData = new FormData();
    formData.append('reqtype', 'deletefiles');
    formData.append('userhash', process.env.CATBOX_USERHASH);
    formData.append('files', filename);

    await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      body: formData,
      headers: { 'User-Agent': BROWSER_UA },
    });
  } catch (e) {
    console.log('Catbox image delete failed:', e.message);
  }
}

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

// GET /api/categories  (public)
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
// IMAGE UPLOAD (via Catbox)
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

      if (!process.env.CATBOX_USERHASH) {
        return res
          .status(500)
          .json({ error: 'Server misconfigured: CATBOX_USERHASH missing' });
      }

      const url = await uploadToCatbox(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname
      );

      res.json({ url, filename: req.file.originalname });
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

// GET /api/posts/:slug
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

    if (oldImage && newImage && oldImage !== newImage) {
      await deleteFromCatbox(oldImage);
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
      await deleteFromCatbox(doc.data().imageUrl);
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
    storage: 'catbox',
  })
);

// Local dev ke liye listen (Vercel pe auto handle hota hai)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
}

module.exports = app;
