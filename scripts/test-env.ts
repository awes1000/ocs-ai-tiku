/**
 * 测试用默认环境变量。
 * 必须作为脚本的【第一个 import】引入，才能在其它模块（如 src/env.ts）求值前生效
 * —— ES 模块按 import 出现顺序深度优先求值。
 *
 * 已存在的同名环境变量不会被覆盖。
 */
function def(key: string, value: string): void {
  if (!process.env[key]) process.env[key] = value;
}

def('DB_PATH', 'data/test.db');
def('PORT', '8099');
def('HOST', '127.0.0.1');
def('ADMIN_USERNAME', 'admin');
def('ADMIN_PASSWORD', 'test-admin-pass');
def('ALLOW_ANONYMOUS', 'false');
def('NODE_ENV', 'test');

/** 测试统一使用的管理员密码 */
export const TEST_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD as string;
