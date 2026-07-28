# Voice2Skill 🚀

**From Learning to Earning.**

Voice2Skill is an AI-powered career and digital skills coach that helps people go from "I don't know where to start" to a structured, accountable path toward a real digital career.

## The Problem

Many people want to learn digital skills — software development, UI/UX design, data analysis, digital marketing — but don't know what to learn, where to start, or how to stay consistent. Free resources exist everywhere, but structure and accountability don't.

## What It Does

- 🎯 Choose a skill track (Software Development, UI/UX Design, Data Analysis, Digital Marketing, Cybersecurity)
- 🗺️ Get an AI-generated, personalized 8-week learning roadmap with real, free resources
- 📚 Follow a structured weekly and daily focus, not a random collection of tutorials
- ✅ Log daily check-ins to track consistency and progress
- 📈 See your check-in history to stay accountable to yourself

## Tech Stack

- **Backend:** Node.js, Express
- **Database:** PostgreSQL (hosted on Neon)
- **Templating:** EJS
- **AI:** Google Gemini API (roadmap generation)
- **Auth:** bcrypt + express-session

## Project Structure
voice2skill/
├── config/ # Database connection
├── controllers/ # Route logic (auth, tracks, roadmaps, checkins)
├── models/ # Database queries
├── routes/ # Express route definitions
├── views/ # EJS templates
├── db/ # Schema definitions
└── server.js # App entry point

## Status

🚧 Early beta — actively being built and tested with early users. Feedback welcome.

## Author

Built by [KAAY_DEV](https://github.com/legacy-king/voice2skill) — CS student at NOUN, freelance developer, and founder exploring digital skills accessibility in Nigeria.