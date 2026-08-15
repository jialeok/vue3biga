<template>
  <EditModal v-model="editModalActive" :title="editModalTitle" @save="saveEditModal">
    <div class="form-row">
      <div class="form-group"><label class="form-label">股票名称</label><input class="form-input" v-model="editForm.name" placeholder="如：综艺股份"></div>
      <div class="form-group"><label class="form-label">相关题材</label><input class="form-input" v-model="editForm.xgcaiti" placeholder="如：人工智能、新能源"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">竞价开盘 %</label><input class="form-input" v-model="editForm.open" placeholder="如：0.79"></div>
      <div class="form-group"><label class="form-label">开盘量比</label><input class="form-input" v-model="editForm.kbiliangkai" placeholder=">=3红色,<3绿色"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">竞符合数形态</label><input class="form-input" v-model="editForm.pattern" placeholder="如：正厂形、U形"></div>
      <div class="form-group"><label class="form-label">零轴位置</label><input class="form-input" v-model="editForm.axis" placeholder="如：零轴上、零轴下"></div>
    </div>
    <div class="form-group"><label class="form-label">备注</label><input class="form-input" v-model="editForm.remark" placeholder="可选填"></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">收盘涨幅 %</label><input class="form-input" v-model="editForm.close" placeholder="如：4.09"></div>
      <div class="form-group"><label class="form-label">换手率 %</label><input class="form-input" v-model="editForm.turnover" placeholder="如：11.5"></div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">阶段</label>
        <select class="form-input" v-model="editForm.stage">
          <option value="其它">其它</option><option value="二板">二板</option><option value="首板">首板</option><option value="连板">连板</option><option value="二波">二波</option><option value="高位">高位</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">调整幅度 %</label><input class="form-input" v-model="editForm.adjust" placeholder="如：-6.6"></div>
    </div>
    <div class="form-group"><label class="form-label">缩放量能</label><input class="form-input" v-model="editForm.sfliangneng" placeholder="如：温和放量"></div>
    <div class="form-group">
      <label class="form-label">标签</label>
      <div class="edit-tags-wrap">
        <label class="edit-tag"><input type="checkbox" v-model="editForm.bomb"><span>💣 炸板</span></label>
        <label class="edit-tag tag-amber"><input type="checkbox" v-model="editForm.bought"><span>已买入</span></label>
        <label class="edit-tag tag-red"><input type="checkbox" v-model="editForm.sold"><span>已卖出</span></label>
        <label class="edit-tag tag-amber-bg"><input type="checkbox" v-model="editForm.sellHigh"><span>冲高卖</span></label>
        <label class="edit-tag tag-blue-bg"><input type="checkbox" v-model="editForm.sell1120"><span>11:20卖</span></label>
        <label class="edit-tag tag-pink-bg"><input type="checkbox" v-model="editForm.sell1450"><span>14:50卖</span></label>
        <label class="edit-tag tag-red"><input type="checkbox" v-model="editForm.dragon"><span>👑 龙头</span></label>
        <label class="edit-tag tag-blue-bg"><input type="checkbox" v-model="editForm.hold"><span>持有</span></label>
        <label class="edit-tag tag-purple-bg"><input type="checkbox" v-model="editForm.watch"><span>观望</span></label>
        <label class="edit-tag tag-red-bg"><input type="checkbox" v-model="editForm.nishi"><span>逆势</span></label>
        <label class="edit-tag tag-emerald-bg"><input type="checkbox" v-model="editForm.shunshi"><span>顺势</span></label>
      </div>
      <div class="edit-nextday">
        <span class="edit-nextday-label">次日预测</span>
        <button type="button" :class="['nextday-pill', { active: editForm.nextDay === 'up' }]" @click="editForm.nextDay = editForm.nextDay === 'up' ? '' : 'up'">📈 次日涨</button>
        <button type="button" :class="['nextday-pill', { active: editForm.nextDay === 'down' }]" @click="editForm.nextDay = editForm.nextDay === 'down' ? '' : 'down'">📉 次日跌</button>
      </div>
    </div>
  </EditModal>
</template>

<script setup>
import EditModal from './EditModal.vue';
import { useHomeStocksState } from '../composables/useHomeStocksState.js';

const { editModalActive, editModalTitle, editForm, saveEditModal } = useHomeStocksState();
</script>
