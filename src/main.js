import { createApp } from 'vue';
import { createPinia } from 'pinia';
import router from './router/index.js';
import App from './App.vue';
import './assets/main.css';


const app = createApp(App);

app.config.errorHandler = (err, instance, info) => {
  console.error('[APP ERROR]', err, info);
};

app.use(createPinia());
app.use(router);

app.mount('#app');
