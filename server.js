const express = require('express');
const session = require('express-session');
const userRoutes = require('./routes/userRoutes');
const trackRoutes = require('./routes/trackRoutes');
const app = express();
require('dotenv').config();
const roadmapRoutes = require('./routes/roadmapRoutes');
const checkinRoutes = require('./routes/checkinRoutes');
const reminderRoutes = require('./routes/reminderRoutes');

// ...
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));
app.use('/', userRoutes);
app.use('/', roadmapRoutes);
app.use('/', trackRoutes);
app.use('/', checkinRoutes);
app.use('/', reminderRoutes);

app.listen(process.env.PORT, () => {
  console.log('Server running on port http://localhost:3000');
});