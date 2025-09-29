const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Cargar configuración
const config = require('./config.json');

const app = express();
app.use(bodyParser.json());
app.use(express.static('.'));

// Base de datos simple en memoria
let appointments = [];
let conversations = {};

// Cargar citas guardadas si existen
try {
    if (fs.existsSync('appointments.json')) {
        appointments = JSON.parse(fs.readFileSync('appointments.json', 'utf8'));
    }
} catch (error) {
    console.log('No hay citas previas guardadas');
}

// Guardar citas
function saveAppointments() {
    fs.writeFileSync('appointments.json', JSON.stringify(appointments, null, 2));
}

// WEBHOOK VERIFICATION (GET) - CRÍTICO PARA META
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    console.log('Verificación webhook recibida:', { mode, token });
    
    if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
        console.log('✅ Webhook verificado correctamente');
        res.status(200).send(challenge);
    } else {
        console.log('❌ Verificación fallida');
        res.sendStatus(403);
    }
});

// WEBHOOK MESSAGES (POST) - RECIBIR MENSAJES
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Responder inmediatamente a WhatsApp
    
    try {
        const body = req.body;
        
        if (body.object === 'whatsapp_business_account') {
            const entry = body.entry?.[0];
            const changes = entry?.changes?.[0];
            const value = changes?.value;
            const messages = value?.messages;
            
            if (messages && messages.length > 0) {
                const message = messages[0];
                const from = message.from;
                const text = message.text?.body || '';
                
                console.log(`📱 Mensaje recibido de ${from}: ${text}`);
                
                // Procesar mensaje
                await processMessage(from, text);
            }
        }
    } catch (error) {
        console.error('❌ Error procesando webhook:', error);
    }
});

// Enviar mensaje de WhatsApp
async function sendWhatsAppMessage(to, message) {
    try {
        const url = `https://graph.facebook.com/v18.0/${config.whatsapp.phoneNumberId}/messages`;
        
        await axios.post(url, {
            messaging_product: 'whatsapp',
            to: to,
            text: { body: message }
        }, {
            headers: {
                'Authorization': `Bearer ${config.whatsapp.accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        
        console.log(`✅ Mensaje enviado a ${to}`);
    } catch (error) {
        console.error('❌ Error enviando mensaje:', error.response?.data || error.message);
    }
}

// Verificar si está en horario
function isOpenNow() {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();
    
    // Verificar día laborable
    if (!config.salon.workingDays.includes(day)) {
        return false;
    }
    
    // Verificar hora
    const openHour = parseInt(config.salon.openTime.split(':')[0]);
    const closeHour = parseInt(config.salon.closeTime.split(':')[0]);
    
    return hour >= openHour && hour < closeHour;
}

// Obtener saludo según hora
function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Buenos días';
    if (hour < 20) return 'Buenas tardes';
    return 'Buenas noches';
}

// Procesar mensaje del usuario
async function processMessage(from, text) {
    const lowerText = text.toLowerCase().trim();
    
    // Inicializar conversación si no existe
    if (!conversations[from]) {
        conversations[from] = {
            step: 'initial',
            data: {}
        };
    }
    
    const conv = conversations[from];
    
    // Verificar horario para funcionalidad completa
    const isOpen = isOpenNow();
    
    // PASO 0: Saludo inicial
    if (conv.step === 'initial') {
        const greeting = getGreeting();
        const salonStatus = isOpen ? '' : '\n\n🌙 Aunque el salón está cerrado ahora, estoy aquí para ayudarte las 24 horas.';
        
        await sendWhatsAppMessage(from, 
            `${greeting} 😊 Soy Ana, tu asistente virtual de ${config.salon.name} 💇‍♀️✨${salonStatus}\n\n¿Deseas reservar una cita?\n\nResponde:\n• SI\n• NO`
        );
        
        conv.step = 'confirm_booking';
        return;
    }
    
    // PASO 1: Confirmar si quiere reservar
    if (conv.step === 'confirm_booking') {
        if (lowerText.includes('si') || lowerText.includes('sí')) {
            // Mostrar servicios
            let servicesText = '¡Perfecto! 🎉 ¿Qué servicio te gustaría?\n\n';
            config.services.forEach((service, index) => {
                servicesText += `${index + 1}. ${service.name} - ${service.price}€ (${service.duration}min)\n`;
            });
            servicesText += '\nEscribe el número del servicio que deseas.';
            
            await sendWhatsAppMessage(from, servicesText);
            conv.step = 'select_service';
        } else {
            await sendWhatsAppMessage(from, 
                'Entendido 😊 Si cambias de opinión, escríbeme cuando quieras. ¡Estoy aquí para ayudarte! 💕'
            );
            delete conversations[from];
        }
        return;
    }
    
    // PASO 2: Seleccionar servicio
    if (conv.step === 'select_service') {
        const serviceIndex = parseInt(lowerText) - 1;
        
        if (serviceIndex >= 0 && serviceIndex < config.services.length) {
            conv.data.service = config.services[serviceIndex];
            
            // Mostrar peluqueros
            let staffText = '¡Genial! 😊 ¿Con qué peluquero prefieres?\n\n';
            config.staff.forEach((person, index) => {
                staffText += `${index + 1}. ${person.name} - ${person.specialty}\n`;
            });
            staffText += `${config.staff.length + 1}. Indiferente\n\nEscribe el número.`;
            
            await sendWhatsAppMessage(from, staffText);
            conv.step = 'select_staff';
        } else {
            await sendWhatsAppMessage(from, 
                'Por favor, escribe un número válido de la lista de servicios.'
            );
        }
        return;
    }
    
    // PASO 3: Seleccionar peluquero
    if (conv.step === 'select_staff') {
        const staffIndex = parseInt(lowerText) - 1;
        
        if (staffIndex >= 0 && staffIndex <= config.staff.length) {
            if (staffIndex === config.staff.length) {
                conv.data.staff = { name: 'Indiferente' };
            } else {
                conv.data.staff = config.staff[staffIndex];
            }
            
            // Preguntar fecha y hora
            await sendWhatsAppMessage(from, 
                '¡Perfecto! 😊 ¿Para cuándo deseas la cita?\n\nEscribe la fecha y hora así:\n📅 DD/MM/YYYY HH:MM\n\nEjemplo: 15/10/2024 14:30'
            );
            conv.step = 'select_datetime';
        } else {
            await sendWhatsAppMessage(from, 
                'Por favor, escribe un número válido de la lista.'
            );
        }
        return;
    }
    
    // PASO 4: Seleccionar fecha y hora
    if (conv.step === 'select_datetime') {
        // Parsear fecha (formato simple)
        const dateMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
        
        if (dateMatch) {
            const [, day, month, year, hour, minute] = dateMatch;
            const appointmentDate = new Date(year, month - 1, day, hour, minute);
            
            conv.data.date = appointmentDate.toISOString();
            conv.data.dateFormatted = `${day}/${month}/${year}`;
            conv.data.time = `${hour}:${minute}`;
            
            // Mostrar confirmación
            const confirmText = `
✨ CONFIRMACIÓN DE CITA ✨

📅 Fecha: ${conv.data.dateFormatted}
🕐 Hora: ${conv.data.time}
✂️ Servicio: ${conv.data.service.name}
💇 Peluquero: ${conv.data.staff.name}
💰 Precio: ${conv.data.service.price}€

¿Confirmas esta cita?

Responde:
- CONFIRMA
- RECHAZA
            `.trim();
            
            await sendWhatsAppMessage(from, confirmText);
            conv.step = 'confirm_appointment';
        } else {
            await sendWhatsAppMessage(from, 
                '❌ Formato incorrecto.\n\nPor favor escribe así:\n📅 DD/MM/YYYY HH:MM\n\nEjemplo: 25/10/2024 16:00'
            );
        }
        return;
    }
    
    // PASO 5: Confirmar cita
    if (conv.step === 'confirm_appointment') {
        if (lowerText.includes('confirma')) {
            // Guardar cita
            const appointment = {
                id: Date.now(),
                phone: from,
                ...conv.data,
                createdAt: new Date().toISOString()
            };
            
            appointments.push(appointment);
            saveAppointments();
            
            await sendWhatsAppMessage(from, 
                `🎉 ¡CITA CONFIRMADA! 🎉\n\n✅ Tu cita ha sido reservada exitosamente.\n\n📲 Recibirás un recordatorio 24h antes.\n\n⚠️ Para cancelar o modificar, comunícalo con 2h de anticipación.\n\n¡Gracias! Te esperamos en ${config.salon.name} 💕`
            );
            
            // Limpiar conversación
            delete conversations[from];
        } else if (lowerText.includes('rechaza')) {
            await sendWhatsAppMessage(from, 
                '❌ Cita cancelada. Si deseas reservar otra, escríbeme cuando quieras 😊'
            );
            delete conversations[from];
        } else {
            await sendWhatsAppMessage(from, 
                'Por favor responde:\n• CONFIRMA\n• RECHAZA'
            );
        }
        return;
    }
    
    // Mensaje por defecto
    await sendWhatsAppMessage(from, 
        'Estoy aquí solo para ayudarte con reservas de citas 😊\n\n¿Deseas reservar una cita? Responde SI o NO.'
    );
    conv.step = 'confirm_booking';
}

// API para obtener citas (para el panel)
app.get('/api/appointments', (req, res) => {
    res.json(appointments);
});

// API para obtener estado
app.get('/api/status', (req, res) => {
    res.json({
        isOpen: isOpenNow(),
        appointments: appointments.length,
        conversations: Object.keys(conversations).length
    });
});

// Servir panel
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Bot WhatsApp funcionando en puerto ${PORT}`);
    console.log(`📱 Webhook: /webhook`);
    console.log(`🌐 Panel: http://localhost:${PORT}`);
});
