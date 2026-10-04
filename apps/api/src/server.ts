import { createApp } from './app.js';
const {app,prisma,config}=createApp(); const stop=async()=>{await app.close();await prisma.$disconnect();process.exit(0)}; process.on('SIGINT',stop);process.on('SIGTERM',stop); app.listen({port:config.API_PORT,host:'0.0.0.0'}).catch(async err=>{app.log.error(err);await stop();});
