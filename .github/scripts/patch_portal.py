#!/usr/bin/env python3
# 向月度报告主站 index.html 的「模块中枢」网格幂等注入「线索罗盘」卡片。
# 设计原则（避免破坏主站 HTML）：
#   1. 幂等：若已含 data-portal="lead-compass" 标记则跳过；
#   2. 安全：锚点（外呼工作台卡片后的 AI 方案中心卡片起始行）不存在时跳过，绝不写半截 HTML；
#   3. 位置：插入在外呼工作台卡片之后、AI 方案中心卡片之前，同属 teal 风格。
import sys, os

MARK = 'data-portal="lead-compass"'
# 锚点：AI 方案中心卡片起始行（外呼工作台卡片之后唯一稳定锚点）
ANCHOR = '      <a class="mod teal" href="ai-proposal-os/">'

CARD = '''      <a class="mod teal" data-portal="lead-compass" href="outbound-workbench/lead-compass.html">
        <div class="top">
          <div class="ic">🧭</div>
          <div><div class="tt">线索罗盘</div><div class="st on"><span class="dot green"></span>在线</div></div>
        </div>
        <div class="ds">高客单价低频次业务的线索可视化看板：管道金额、单条线索产值、CPL、营销 ROI 与回传构成实时洞察。</div>
        <div class="go">进入看板 <span class="ar">→</span></div>
      </a>
'''

def main():
    if len(sys.argv) < 2:
        print("用法: patch_portal.py <monthly-report/index.html 路径>")
        return 2
    path = sys.argv[1]
    if not os.path.isfile(path):
        print(f"✗ 文件不存在: {path}（跳过，不阻塞 sync）")
        return 0
    with open(path, 'r', encoding='utf-8') as f:
        html = f.read()

    if MARK in html:
        print("✓ 线索罗盘卡片已存在，跳过注入（幂等）")
        return 0

    if ANCHOR not in html:
        print("⚠ 锚点（AI 方案中心卡片）未找到，跳过注入以避免破坏主站 HTML")
        return 0

    # 在锚点前插入卡片（保留锚点原行）
    html = html.replace(ANCHOR, CARD + ANCHOR, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    print("✓ 已注入线索罗盘卡片到模块中枢")
    return 0

if __name__ == '__main__':
    sys.exit(main())
