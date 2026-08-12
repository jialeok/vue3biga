import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/', name: 'home', component: () => import('../views/DashboardView.vue') },
  { path: '/auction', name: 'auction', component: () => import('../views/AuctionBoard.vue') },
  { path: '/pattern', name: 'pattern', component: () => import('../views/PatternBoard.vue') },
  { path: '/duiban', name: 'duiban', component: () => import('../views/DuibanBoard.vue') },
  { path: '/etf', name: 'etf', component: () => import('../views/EtfBoard.vue') },
  { path: '/jiwang', name: 'jiwang', component: () => import('../views/JiwangBoard.vue') },
  { path: '/emotion', name: 'emotion', component: () => import('../views/EmotionBoard.vue') },
  { path: '/bidding', name: 'bidding', component: () => import('../views/BiddingBoard.vue') },
  { path: '/stats', name: 'stats', component: () => import('../views/StatsBoard.vue') },
  { path: '/tag-titles', name: 'tag-titles', component: () => import('../views/TagTitlesBoard.vue') },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
