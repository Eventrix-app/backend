-- Eventrix Database Schema for Supabase (PostgreSQL)
-- This schema defines all tables needed for the event discovery and booking platform
-- Note: This is PostgreSQL syntax for Supabase. Not compatible with MSSQL.

-- ============================================================================
-- 1. USERS TABLE - Core user data and authentication
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  full_name VARCHAR(255),
  phone_number VARCHAR(20),
  password_hash VARCHAR(255),
  profile_picture_url TEXT,
  bio TEXT,
  location VARCHAR(255),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  date_of_birth DATE,
  gender VARCHAR(20),
  role VARCHAR(50) DEFAULT 'user', -- 'user', 'organizer', 'admin'
  is_email_verified BOOLEAN DEFAULT FALSE,
  is_phone_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

-- ============================================================================
-- 2. USER INTERESTS - User preferences for event categories
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_interests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_name VARCHAR(100) NOT NULL,
  interest_level INTEGER DEFAULT 1, -- 1-5 scale
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_interests_user_id ON user_interests(user_id);

-- ============================================================================
-- 3. EVENT CATEGORIES - Available event categories
-- ============================================================================
CREATE TABLE IF NOT EXISTS event_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  emoji VARCHAR(10),
  color_hex VARCHAR(7),
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 4. ORGANIZERS - Event organizer/company profiles
-- ============================================================================
CREATE TABLE IF NOT EXISTS organizers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name VARCHAR(255) NOT NULL,
  company_description TEXT,
  company_website VARCHAR(255),
  company_logo_url TEXT,
  verified BOOLEAN DEFAULT FALSE,
  verified_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_organizers_user_id ON organizers(user_id);

-- ============================================================================
-- 5. EVENTS - Main events table
-- ============================================================================
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category_id UUID NOT NULL REFERENCES event_categories(id),
  venue_name VARCHAR(255) NOT NULL,
  venue_address TEXT NOT NULL,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  event_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME,
  duration_minutes INTEGER,
  price_per_ticket DECIMAL(10, 2),
  currency VARCHAR(10) DEFAULT 'INR',
  total_capacity INTEGER,
  available_tickets INTEGER,
  featured BOOLEAN DEFAULT FALSE,
  image_url TEXT,
  cover_image_url TEXT,
  status VARCHAR(50) DEFAULT 'active', -- 'draft', 'active', 'cancelled', 'completed'
  ticket_sales_open_date DATE,
  ticket_sales_close_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_events_organizer_id ON events(organizer_id);
CREATE INDEX idx_events_category_id ON events(category_id);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_featured ON events(featured);
CREATE INDEX idx_events_date ON events(event_date);

-- ============================================================================
-- 6. EVENT BOOKINGS - User tickets and bookings
-- ============================================================================
CREATE TABLE IF NOT EXISTS event_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  booking_reference VARCHAR(50) UNIQUE NOT NULL,
  quantity_tickets INTEGER NOT NULL DEFAULT 1,
  total_price DECIMAL(10, 2),
  payment_status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'completed', 'failed', 'refunded'
  payment_method VARCHAR(50),
  booking_status VARCHAR(50) DEFAULT 'confirmed', -- 'confirmed', 'cancelled', 'used'
  qr_code_url TEXT,
  booking_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  cancelled_date TIMESTAMP,
  used_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_event_bookings_user_id ON event_bookings(user_id);
CREATE INDEX idx_event_bookings_event_id ON event_bookings(event_id);
CREATE INDEX idx_event_bookings_status ON event_bookings(booking_status);
CREATE INDEX idx_event_bookings_reference ON event_bookings(booking_reference);

-- ============================================================================
-- 7. INDIVIDUAL TICKETS - Individual ticket details for each booking
-- ============================================================================
CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES event_bookings(id) ON DELETE CASCADE,
  ticket_number VARCHAR(50) UNIQUE NOT NULL,
  qr_code VARCHAR(500),
  seat_number VARCHAR(50),
  status VARCHAR(50) DEFAULT 'valid', -- 'valid', 'used', 'cancelled'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tickets_booking_id ON tickets(booking_id);

-- ============================================================================
-- 8. USER SAVED EVENTS - Favorites/Wishlist
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_saved_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, event_id)
);

CREATE INDEX idx_user_saved_events_user_id ON user_saved_events(user_id);
CREATE INDEX idx_user_saved_events_event_id ON user_saved_events(event_id);

-- ============================================================================
-- 9. EVENT REVIEWS - Reviews and ratings for events
-- ============================================================================
CREATE TABLE IF NOT EXISTS event_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_title VARCHAR(255),
  review_text TEXT,
  helpful_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, event_id)
);

CREATE INDEX idx_event_reviews_user_id ON event_reviews(user_id);
CREATE INDEX idx_event_reviews_event_id ON event_reviews(event_id);

-- ============================================================================
-- 10. SHORTS - Short-form videos (TikTok-style)
-- ============================================================================
CREATE TABLE IF NOT EXISTS shorts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  title VARCHAR(255),
  description TEXT,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  duration_seconds INTEGER,
  category VARCHAR(100),
  tags TEXT[], -- Array of tags
  view_count INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'published', -- 'draft', 'published', 'hidden', 'removed'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_shorts_creator_id ON shorts(creator_id);
CREATE INDEX idx_shorts_event_id ON shorts(event_id);
CREATE INDEX idx_shorts_status ON shorts(status);

-- ============================================================================
-- 11. SHORTS LIKES - Likes on short videos
-- ============================================================================
CREATE TABLE IF NOT EXISTS shorts_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  short_id UUID NOT NULL REFERENCES shorts(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, short_id)
);

CREATE INDEX idx_shorts_likes_user_id ON shorts_likes(user_id);
CREATE INDEX idx_shorts_likes_short_id ON shorts_likes(short_id);

-- ============================================================================
-- 12. SHORTS COMMENTS - Comments on short videos
-- ============================================================================
CREATE TABLE IF NOT EXISTS shorts_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_id UUID NOT NULL REFERENCES shorts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_text TEXT NOT NULL,
  likes_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_shorts_comments_short_id ON shorts_comments(short_id);
CREATE INDEX idx_shorts_comments_user_id ON shorts_comments(user_id);

-- ============================================================================
-- 13. SHORTS BOOKMARKS - Saved shorts
-- ============================================================================
CREATE TABLE IF NOT EXISTS shorts_bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  short_id UUID NOT NULL REFERENCES shorts(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, short_id)
);

CREATE INDEX idx_shorts_bookmarks_user_id ON shorts_bookmarks(user_id);

-- ============================================================================
-- 14. NOTIFICATIONS - User notifications
-- ============================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- 'booking_confirmation', 'event_reminder', 'event_update', 'new_follower', etc.
  title VARCHAR(255) NOT NULL,
  message TEXT,
  related_event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);

-- ============================================================================
-- 15. USER FOLLOWERS - Following system
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_followers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(follower_id, following_id),
  CHECK (follower_id != following_id)
);

CREATE INDEX idx_user_followers_follower_id ON user_followers(follower_id);
CREATE INDEX idx_user_followers_following_id ON user_followers(following_id);

-- ============================================================================
-- 16. PAYMENTS - Payment transaction history
-- ============================================================================
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES event_bookings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'INR',
  payment_method VARCHAR(50),
  transaction_id VARCHAR(255) UNIQUE,
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'completed', 'failed', 'refunded'
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_payments_booking_id ON payments(booking_id);
CREATE INDEX idx_payments_status ON payments(status);

-- ============================================================================
-- Insert Default Categories
-- ============================================================================
INSERT INTO event_categories (name, emoji, color_hex, description) VALUES
  ('Music', '🎵', '#FF3366', 'Live music, concerts, and festivals'),
  ('Tech', '💻', '#3B82F6', 'Tech conferences, workshops, and meetups'),
  ('Sports', '⚽', '#10B981', 'Sports events and competitions'),
  ('Health', '🧘', '#8B5CF6', 'Health, wellness, and fitness events'),
  ('Business', '💼', '#F59E0B', 'Business networking and conferences'),
  ('Education', '📚', '#EC4899', 'Workshops, seminars, and courses'),
  ('Food', '🍔', '#FF6B6B', 'Food festivals and culinary events'),
  ('Art', '🎨', '#9B59B6', 'Art exhibitions and cultural events')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Create Views for Common Queries
-- ============================================================================

-- View for event details with organizer info
CREATE OR REPLACE VIEW v_events_with_details AS
SELECT 
  e.id,
  e.title,
  e.description,
  e.venue_name,
  e.venue_address,
  e.event_date,
  e.start_time,
  e.end_time,
  e.price_per_ticket,
  e.total_capacity,
  e.available_tickets,
  e.featured,
  e.image_url,
  ec.name as category_name,
  ec.emoji as category_emoji,
  o.company_name as organizer_name,
  u.full_name as organizer_full_name,
  COUNT(eb.id) as total_bookings,
  AVG(er.rating)::DECIMAL(3,2) as average_rating,
  COUNT(use.id) as save_count
FROM events e
LEFT JOIN event_categories ec ON e.category_id = ec.id
LEFT JOIN organizers o ON e.organizer_id = o.id
LEFT JOIN users u ON o.user_id = u.id
LEFT JOIN event_bookings eb ON e.id = eb.event_id
LEFT JOIN event_reviews er ON e.id = er.event_id
LEFT JOIN user_saved_events use ON e.id = use.event_id
GROUP BY e.id, ec.id, o.id, u.id;

-- View for user profile with statistics
CREATE OR REPLACE VIEW v_user_profile_stats AS
SELECT 
  u.id,
  u.email,
  u.full_name,
  u.profile_picture_url,
  u.bio,
  COUNT(DISTINCT eb.id) as total_bookings,
  COUNT(DISTINCT use.id) as saved_events,
  COUNT(DISTINCT uf.follower_id) as followers_count,
  COUNT(DISTINCT uf2.following_id) as following_count,
  COUNT(DISTINCT s.id) as shorts_created,
  COUNT(DISTINCT er.id) as reviews_written
FROM users u
LEFT JOIN event_bookings eb ON u.id = eb.user_id
LEFT JOIN user_saved_events use ON u.id = use.user_id
LEFT JOIN user_followers uf ON u.id = uf.following_id
LEFT JOIN user_followers uf2 ON u.id = uf2.follower_id
LEFT JOIN shorts s ON u.id = s.creator_id
LEFT JOIN event_reviews er ON u.id = er.user_id
GROUP BY u.id;
