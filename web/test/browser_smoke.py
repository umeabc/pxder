"""Real Chromium against demo-server.js (test doubles only, no real Pixiv data)."""

import io
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
url = 'http://127.0.0.1:' + os.getenv('PXDER_TEST_PORT', '18781')
password = 'fake-test-password-not-for-deployment'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    desktop = browser.new_page(viewport={'width': 1280, 'height': 820})
    errors = []
    desktop.on('pageerror', lambda error: errors.append(str(error)))
    desktop.on('console', lambda msg: errors.append(msg.text) if 'Content Security Policy' in msg.text else None)
    desktop.goto(url)
    desktop.wait_for_load_state('networkidle')
    expect(desktop.locator('#login-form')).to_be_visible()
    desktop.get_by_label('管理员密码').fill(password)
    desktop.get_by_role('button', name='登录工作台').click()
    expect(desktop.get_by_role('heading', name='新建下载任务')).to_be_visible()
    desktop.get_by_role('link', name='旧库索引').click()
    expect(desktop.locator('#scan-button')).to_be_enabled()
    data = {'format': 'pxder-library-v1', 'assets': [['42', 'image', 0]]}
    desktop.locator('#manifest-file').set_input_files({'name': '旧库示例.json', 'mimeType': 'application/json', 'buffer': json.dumps(data).encode()})
    desktop.get_by_role('button', name='导入索引').click()
    expect(desktop.locator('#assets-count')).to_have_text('1')
    expect(desktop.get_by_text('旧库示例.json')).to_be_visible()
    desktop.get_by_role('link', name='新建任务').click()
    desktop.locator('#job-values').fill('https://www.pixiv.net/artworks/42')
    desktop.locator('#job-dry').check()
    desktop.get_by_role('button', name='开始筛选').click()
    row = desktop.locator('.job-row').filter(has_text='仅筛选')
    expect(row.locator('.status-completed')).to_have_text('已完成', timeout=12000)
    expect(row.locator('.count-skipped dd')).to_have_text('1')
    expect(row.locator('.count-missing dd')).to_have_text('1')
    row.get_by_role('button', name='补齐缺失图片').click()
    expect(desktop.locator('.job-row').first.locator('.status-completed')).to_have_text('已完成', timeout=12000)
    expect(desktop.locator('.job-row').first.locator('.count-downloaded dd')).to_have_text('1')
    if len(sys.argv) > 1:
        desktop.screenshot(path=str(Path(sys.argv[1]).resolve()), full_page=True)
    desktop.get_by_role('link', name='旧库索引').click()
    desktop.get_by_role('button', name='扫描服务器旧目录').click()
    expect(desktop.locator('.job-row').filter(has_text='扫描旧图目录').locator('.status-completed')).to_have_text('已完成', timeout=12000)
    desktop.get_by_role('link', name='旧库索引').click()
    expect(desktop.locator('#assets-count')).to_have_text('4')
    desktop.on('dialog', lambda dialog: dialog.accept())
    desktop.locator('.source-row').filter(has_text='旧库示例.json').get_by_role('button', name='移除索引').click()
    expect(desktop.get_by_text('旧库示例.json')).to_have_count(0)
    expect(desktop.locator('#assets-count')).to_have_text('4')

    mobile = browser.new_page(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    mobile.goto(url + '/#library')
    mobile.wait_for_load_state('networkidle')
    mobile.get_by_label('管理员密码').fill(password)
    mobile.get_by_role('button', name='登录工作台').click()
    expect(mobile.locator('#assets-count')).to_have_text('4')
    assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'horizontal overflow on mobile'
    mobile.get_by_role('button', name='退出登录').click()
    expect(mobile.locator('#login-view')).to_be_visible()
    assert not errors, errors
    browser.close()

print('Chromium passed: login, JSON import, per-page screen and download, scan, remove, mobile and logout.')
