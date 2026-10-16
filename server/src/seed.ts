export const FACILITY_ID = 'facility-demo';
export const FACILITY_NAME = 'PlayBack Demo Club';
export const LAPTOP_COURT = 'court-1';

export type SeedPlayer = {
  id: string;
  slug: string;
  displayName: string;
  language: 'en' | 'vi';
  skill: string | null;
  hand: 'left' | 'right' | null;
  pir: number;
};

export const SEED_PLAYERS: SeedPlayer[] = [
  { id: 'demo-minh', slug: 'minh', displayName: 'Minh Trần', language: 'vi', skill: 'Club', hand: 'right', pir: 1520 },
  { id: 'demo-lan', slug: 'lan', displayName: 'Lan Phạm', language: 'vi', skill: 'Match play', hand: 'left', pir: 1680 },
  { id: 'demo-an', slug: 'an', displayName: 'An Nguyễn', language: 'en', skill: 'Club', hand: 'right', pir: 1410 },
  { id: 'demo-khoa', slug: 'khoa', displayName: 'Khoa Lê', language: 'vi', skill: 'Club', hand: 'right', pir: 1595 },
  { id: 'demo-ha', slug: 'ha', displayName: 'Hà Võ', language: 'vi', skill: 'Club', hand: 'left', pir: 1550 },
  { id: 'demo-quang', slug: 'quang', displayName: 'Quang Đỗ', language: 'en', skill: 'Match play', hand: 'right', pir: 1710 },
  { id: 'demo-mai', slug: 'mai', displayName: 'Mai Bùi', language: 'vi', skill: 'Club', hand: 'right', pir: 1380 },
  { id: 'demo-tuan', slug: 'tuan', displayName: 'Tuấn Hoàng', language: 'en', skill: 'Club', hand: 'left', pir: 1605 },
];

export const SIMULATED_COURTS: { id: string; number: number; activity: string }[] = [
  { id: 'court-2', number: 2, activity: 'idle' },
  { id: 'court-3', number: 3, activity: 'in-use' },
  { id: 'court-4', number: 4, activity: 'between-games' },
  { id: 'court-5', number: 5, activity: 'idle' },
  { id: 'court-6', number: 6, activity: 'in-use' },
  { id: 'court-7', number: 7, activity: 'idle' },
  { id: 'court-8', number: 8, activity: 'reserved' },
];

export const DEMO_ANALYTICS = {
  id: 'brochure-hours',
  titleEn: 'Sample court time',
  titleVi: 'Giờ chơi mẫu',
  bodyEn: 'A brochure sketch of busy hours. It is not calculated from matches on this computer.',
  bodyVi: 'Bản phác giờ đông khách cho tờ giới thiệu. Không được tính từ các trận trên máy này.',
};
