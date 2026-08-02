CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verification_token TEXT,
  verification_token_expires TIMESTAMP,
  password_reset_token TEXT,
  password_reset_token_expires TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tracks (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT
);

INSERT INTO tracks (name, description) VALUES
('Web Development', 'HTML, CSS, JavaScript — build and ship real sites.'),
('UI/UX Design', 'Design thinking, Figma, and interfaces people love.'),
('Data Analysis', 'Spreadsheets, SQL, and insights that drive decisions.'),
('Digital Marketing', 'Content, SEO, and campaigns that reach people.'),
('Cybersecurity', 'Fundamentals of protecting systems and data.');

CREATE TABLE roadmaps (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  goal TEXT,
  content JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE checkins (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  roadmap_id INTEGER NOT NULL REFERENCES roadmaps(id),
  checkin_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, roadmap_id, checkin_date)
);