const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function test() {
  try {
    await prisma.$connect();
    console.log('✅ Prisma 连接成功！');
    const result = await prisma.$queryRaw`SELECT 1 as test`;
    console.log('查询测试:', result);
  } catch (error) {
    console.error('❌ 连接失败:', error.message);
    console.error('错误码:', error.code);
  } finally {
    await prisma.$disconnect();
  }
}

test();