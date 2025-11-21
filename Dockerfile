# ใช้ official Oven Bun image
FROM oven/bun:latest

# ตั้ง working directory
WORKDIR /app

# คัดลอกไฟล์โปรเจกต์ทั้งหมด
COPY . .

# ติดตั้ง dependencies (ถ้ามี) ด้วย bun
RUN bun install

# expose port 3001 ให้ container
EXPOSE 3001

# รัน server
CMD ["bun", "run", "server.ts"]
