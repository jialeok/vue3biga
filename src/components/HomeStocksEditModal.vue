<template>
  <EditModal
    v-model="editModalActive"
    :title="editModalTitle"
    @save="saveEditModal"
  >
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">股票名称</label><input
          v-model="editForm.name"
          class="form-input"
          placeholder="如：综艺股份"
        >
      </div>
      <div class="form-group">
        <label class="form-label">相关题材</label><input
          v-model="editForm.xgcaiti"
          class="form-input"
          placeholder="如：人工智能、新能源"
        >
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">竞价开盘 %</label><input
          v-model="editForm.open"
          class="form-input"
          placeholder="如：0.79"
        >
      </div>
      <div class="form-group">
        <label class="form-label">开盘量比</label><input
          v-model="editForm.kbiliangkai"
          class="form-input"
          placeholder=">=3红色,<3绿色"
        >
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">竞符合数形态</label><input
          v-model="editForm.pattern"
          class="form-input"
          placeholder="如：正厂形、U形"
        >
      </div>
      <div class="form-group">
        <label class="form-label">零轴位置</label><input
          v-model="editForm.axis"
          class="form-input"
          placeholder="如：零轴上、零轴下"
        >
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">备注</label><input
        v-model="editForm.remark"
        class="form-input"
        placeholder="可选填"
      >
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">收盘涨幅 %</label><input
          v-model="editForm.close"
          class="form-input"
          placeholder="如：4.09"
        >
      </div>
      <div class="form-group">
        <label class="form-label">换手率 %</label><input
          v-model="editForm.turnover"
          class="form-input"
          placeholder="如：11.5"
        >
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">阶段</label>
        <select
          v-model="editForm.stage"
          class="form-input"
        >
          <option value="其它">
            其它
          </option><option value="二板">
            二板
          </option><option value="首板">
            首板
          </option><option value="连板">
            连板
          </option><option value="二波">
            二波
          </option><option value="高位">
            高位
          </option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">调整幅度 %</label><input
          v-model="editForm.adjust"
          class="form-input"
          placeholder="如：-6.6"
        >
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">缩放量能</label><input
        v-model="editForm.sfliangneng"
        class="form-input"
        placeholder="如：温和放量"
      >
    </div>
    <div class="form-group">
      <label class="form-label">标签</label>
      <div class="edit-tags-wrap">
        <label class="edit-tag"><input
          v-model="editForm.bomb"
          type="checkbox"
        ><span>💣 炸板</span></label>
        <label class="edit-tag tag-amber"><input
          v-model="editForm.bought"
          type="checkbox"
        ><span>已买入</span></label>
        <label class="edit-tag tag-red"><input
          v-model="editForm.sold"
          type="checkbox"
        ><span>已卖出</span></label>
        <label class="edit-tag tag-amber-bg"><input
          v-model="editForm.sellHigh"
          type="checkbox"
        ><span>冲高卖</span></label>
        <label class="edit-tag tag-blue-bg"><input
          v-model="editForm.sell1120"
          type="checkbox"
        ><span>11:20卖</span></label>
        <label class="edit-tag tag-pink-bg"><input
          v-model="editForm.sell1450"
          type="checkbox"
        ><span>14:50卖</span></label>
        <label class="edit-tag tag-red"><input
          v-model="editForm.dragon"
          type="checkbox"
        ><span>👑 龙头</span></label>
        <label class="edit-tag tag-blue-bg"><input
          v-model="editForm.hold"
          type="checkbox"
        ><span>持有</span></label>
        <label class="edit-tag tag-purple-bg"><input
          v-model="editForm.watch"
          type="checkbox"
        ><span>观望</span></label>
        <label class="edit-tag tag-red-bg"><input
          v-model="editForm.nishi"
          type="checkbox"
        ><span>逆势</span></label>
        <label class="edit-tag tag-emerald-bg"><input
          v-model="editForm.shunshi"
          type="checkbox"
        ><span>顺势</span></label>
      </div>
      <div class="edit-nextday">
        <span class="edit-nextday-label">次日预测</span>
        <button
          type="button"
          :class="['nextday-pill', { active: editForm.nextDay === 'up' }]"
          @click="toggleNextDay('up')"
        >
          📈 次日涨
        </button>
        <button
          type="button"
          :class="['nextday-pill', { active: editForm.nextDay === 'down' }]"
          @click="toggleNextDay('down')"
        >
          📉 次日跌
        </button>
      </div>
    </div>
  </EditModal>
</template>

<script setup>
import EditModal from './EditModal.vue';
import { useHomeStocksState } from '../composables/useHomeStocksState.js';

const { editModalActive, editModalTitle, editForm, saveEditModal } = useHomeStocksState();

function toggleNextDay(target) {
  editForm.nextDay = editForm.nextDay === target ? '' : target;
}
</script>
