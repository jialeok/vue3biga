<template>
  <LoginOverlay ref="loginRef" />
  <DebugLogModal ref="debugRef" />
  <NumcatChoiceModal />
  <RouterView v-if="authReady" />
</template>

<script setup>
import { ref } from 'vue';
import LoginOverlay from './components/LoginOverlay.vue';
import DebugLogModal from './components/DebugLogModal.vue';
import NumcatChoiceModal from './components/NumcatChoiceModal.vue';
import { useAppBootstrap } from './composables/useAppBootstrap.js';
import { useAuthStore } from './stores/authStore.js';

const loginRef = ref(null);
const debugRef = ref(null);
const { authReady } = useAppBootstrap(loginRef);
</script>
