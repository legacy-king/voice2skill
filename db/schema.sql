CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tracks (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT
);

INSERT INTO tracks (name, description) VALUES
('Software Development', 'Full-stack, backend, and mobile frameworks guided by real-world challenges.'),
('UI/UX Design', 'Design principles, prototyping, and user research for digital products.'),
('Data Analysis', 'Data cleaning, visualization, and insights using modern tools.'),
('Digital Marketing', 'SEO, content strategy, and growth marketing for digital brands.'),
('Cybersecurity', 'Offensive and defensive security strategies to protect the digital frontier.');

CREATE TABLE roadmaps (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  track_id INTEGER NOT NULL REFERENCES tracks(id),
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