// 目录入口：Node 24 的 `node --test <目录>` 不会展开目录下的测试文件，
// 而是把目录当模块入口加载。这里把四个测试文件注册进来，
// 让验收命令 `node --test test-client` 可以直接使用。
import './loader.test.mjs';
import './api.test.mjs';
import './panel.test.mjs';
import './render.test.mjs';
